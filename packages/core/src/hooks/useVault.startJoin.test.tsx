/** @vitest-environment happy-dom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../context/PlatformContext";
import { encodePairingCode } from "../sync/enrollment";
import { VAULT_REGISTRY_KEY, type VaultRegistry } from "../vault/vault-registry";
import { useVaultActions, VaultProvider } from "./useVault";
import { VaultRegistryProvider } from "./useVaultRegistry";

afterEach(cleanup);

// Regression guard for the join re-entry bug: startJoin registers a vault record, then defers the
// handshake to an effect. Without a guard, a second call (a double tap on "Join vault", reachable
// before `joining` re-renders the button disabled) started a SECOND join - a second registry record,
// and pendingJoin + joinResolverRef overwritten, so the first record was stranded in the registry
// forever: an unopenable "Vault 1" the picker offers but that dead-ends on the first-run screen.
// The dedup at the top of startJoin can't catch this: it only matches a PERSISTED sync.group, which
// an in-flight join hasn't written yet.

const CODE = encodePairingCode({
	v: 1,
	groupKey: "Z3JvdXA=",
	inviterPub: "cHVi",
	psk: "cHNr",
	relay: "wss://relay.example",
});

function makePlatform() {
	let registry: VaultRegistry = { vaults: [] };
	const setActiveVault = vi.fn(async () => {});
	const storage = {
		hasVaultHandle: vi.fn(async () => false), // mount effect returns early (no crypto on mount)
		getMeta: vi.fn(async (k: string) => (k === VAULT_REGISTRY_KEY ? registry : undefined)),
		setMeta: vi.fn(async (k: string, v: unknown) => {
			if (k === VAULT_REGISTRY_KEY) registry = v as VaultRegistry;
		}),
		readVaultBlob: vi.fn(async () => new Uint8Array()),
		writeVaultBlob: vi.fn(async () => {}),
	};
	const crypto = {
		isLocked: vi.fn(async () => true),
		onExternalLock: vi.fn(() => () => {}),
		onExternalChange: vi.fn(() => () => {}),
	};
	const shell = {
		setActiveVault,
		getActiveVault: vi.fn(async () => null),
		flushPendingCornerCapture: vi.fn(async () => {}),
		// Never settles: keeps the first join in flight for the duration of the test.
		startEnrollJoin: vi.fn(() => new Promise<void>(() => {})),
		stopSyncSpike: vi.fn(async () => {}),
	};
	const platform = {
		storage,
		crypto,
		autofill: { clearIndex: vi.fn(async () => {}), setIndex: vi.fn(async () => {}) },
		shell,
		clipboard: {},
	} as unknown as Platform;
	return { platform, setActiveVault };
}

function mountActions(platform: Platform) {
	let actions: ReturnType<typeof useVaultActions> | null = null;
	function Consumer() {
		actions = useVaultActions();
		return null;
	}
	render(
		<PlatformProvider platform={platform}>
			<VaultRegistryProvider>
				<VaultProvider>
					<Consumer />
				</VaultProvider>
			</VaultRegistryProvider>
		</PlatformProvider>,
	);
	return () => {
		if (!actions) throw new Error("actions not captured");
		return actions;
	};
}

describe("startJoin re-entry", () => {
	it("starts ONE join when called twice before the first settles", async () => {
		const { platform, setActiveVault } = makePlatform();
		const getActions = mountActions(platform);
		await act(async () => {}); // flush the registry load

		let first: Promise<void> | null = null;
		let second: Promise<void> | null = null;
		await act(async () => {
			first = getActions().startJoin(CODE, { kind: "password", password: "pw" });
			second = getActions().startJoin(CODE, { kind: "password", password: "pw" });
			void first.catch(() => {});
			void second.catch(() => {});
		});

		// Each join creates a record and makes it active. A second one would strand the first.
		expect(setActiveVault).toHaveBeenCalledTimes(1);
		// The second call rode the in-flight join rather than starting its own.
		expect(second).toBe(first);
	});
});
