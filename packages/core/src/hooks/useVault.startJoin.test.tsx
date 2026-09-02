/** @vitest-environment happy-dom */
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import { encodePairingCode } from "../sync/enrollment";
import { mountVaultActions } from "../test/vault-harness";
import { VAULT_REGISTRY_KEY, type VaultRegistry } from "../vault/vault-registry";

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
	return { platform, setActiveVault, storage };
}

describe("startJoin re-entry", () => {
	it("starts ONE join when called twice before the first settles", async () => {
		const { platform, setActiveVault } = makePlatform();
		const getActions = mountVaultActions(platform);
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

/**
 * The labels of every vault this join wrote into the registry.
 *
 * Read from the writes rather than the final registry because the harness never lets a join
 * settle, so the record is created and then dropped as an orphan. What is under test is the
 * record as CREATED.
 */
function createdLabels(storage: { setMeta: { mock: { calls: unknown[][] } } }): string[] {
	const writes = storage.setMeta.mock.calls.filter((c) => c[0] === VAULT_REGISTRY_KEY);
	const first = writes[0]?.[1] as VaultRegistry | undefined;
	return (first?.vaults ?? []).map((v) => v.label);
}

describe("the vault a join creates", () => {
	it("carries the label the caller gave it", async () => {
		// An unlabelled vault appearing mid-flow is what made "connect a browser" read as the app
		// swallowing the user's entries: the list gained a blank "Vault 2" with nothing tying it to
		// the desktop app the user had just pressed a button about.
		const { platform, storage } = makePlatform();
		const getActions = mountVaultActions(platform);
		await act(async () => {});

		await act(async () => {
			void getActions().startJoin(CODE, { kind: "password", password: "pw" }, "Desktop vault");
		});
		// startJoin resolves only once the join settles, which this platform never lets happen;
		// the record is written before that, so flush the microtasks rather than await the call.
		await act(async () => {});

		expect(createdLabels(storage)).toEqual(["Desktop vault"]);
	});

	it("is blank when no label is given, so other callers are unchanged", async () => {
		const { platform, storage } = makePlatform();
		const getActions = mountVaultActions(platform);
		await act(async () => {});

		await act(async () => {
			void getActions().startJoin(CODE, { kind: "password", password: "pw" });
		});
		await act(async () => {});

		expect(createdLabels(storage)).toEqual([""]);
	});
});

describe("joining is master-password only", () => {
	/** A credential stub, present so a stray ceremony would be caught rather than silently pass. */
	function stubAuthenticator() {
		const create = vi.fn(async (_opts: { publicKey: unknown }) => ({
			rawId: new Uint8Array([1, 2, 3]).buffer,
			response: { getAuthenticatorData: () => new Uint8Array(37).buffer },
			getClientExtensionResults: () => ({
				prf: { results: { first: new Uint8Array(32).fill(9).buffer } },
			}),
		}));
		vi.stubGlobal("navigator", { credentials: { create, get: vi.fn() } });
		return create;
	}

	afterEach(() => vi.unstubAllGlobals());

	it("runs no webauthn ceremony", async () => {
		// The key-based join was removed: it skipped a joiner-side check that never gated the VEK
		// anyway, and nothing but a password-less vault wanted it. This guards the removal, since
		// the ceremony is invisible in the UI and would come back unnoticed.
		const create = stubAuthenticator();
		const { platform } = makePlatform();
		const getActions = mountVaultActions(platform);
		await act(async () => {});

		await act(async () => {
			void getActions().startJoin(CODE, { kind: "password", password: "pw" });
		});
		await act(async () => {});

		expect(create).not.toHaveBeenCalled();
	});
});
