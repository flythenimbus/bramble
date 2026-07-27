/** @vitest-environment happy-dom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../context/PlatformContext";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";
import { useVaultActions, VaultProvider } from "./useVault";
import { VaultRegistryProvider } from "./useVaultRegistry";

afterEach(cleanup);

// Regression guard for the resetSyncState scoping (docs/multiple-vaults.md "resetSyncState,
// per-vault"): createVault resets device-global sync identity ONLY for the first vault. Creating an
// additional vault must NOT reset it, or it would wipe the sibling vault's Noise/Ed25519 keys +
// group and knock that vault off its sync mesh. Now that "Add a vault" (create/join) is offered on
// mobile too, a regression here is user-reachable, so pin it down.
//
// The test seeds the registry with N vaults, then calls createVault. The resetSyncState decision
// happens right after createRecord and BEFORE any crypto, so we stub generateVek to reject: it
// short-circuits createVault immediately after the guard, and the rest of the create path (Argon2,
// blob build) is out of scope. We assert only whether resetSyncState fired.
function makePlatform(existingVaults: number) {
	const registry = {
		vaults: Array.from({ length: existingVaults }, (_, i) => ({
			id: `v${i}`,
			label: "",
			createdAt: 1,
		})),
	};
	const resetSyncState = vi.fn(async () => {});
	const storage = {
		hasVaultHandle: vi.fn(async () => false), // mount effect returns early (no crypto on mount)
		getMeta: vi.fn(async (k: string) => (k === VAULT_REGISTRY_KEY ? registry : undefined)),
		setMeta: vi.fn(async () => {}),
		readVaultBlob: vi.fn(async () => new Uint8Array()),
		writeVaultBlob: vi.fn(async () => {}),
	};
	const crypto = {
		isLocked: vi.fn(async () => true),
		onExternalLock: vi.fn(() => () => {}),
		onExternalChange: vi.fn(() => () => {}),
		// Rejects to stop createVault immediately after the resetSyncState guard.
		generateVek: vi.fn(async () => {
			throw new Error("stop after the sync-reset guard");
		}),
	};
	const shell = {
		resetSyncState,
		setActiveVault: vi.fn(async (_id: string | null) => {}),
		getActiveVault: vi.fn(async () => null),
		flushPendingCornerCapture: vi.fn(async () => {}),
	};
	const platform = {
		storage,
		crypto,
		autofill: { clearIndex: vi.fn(async () => {}), setIndex: vi.fn(async () => {}) },
		shell,
		clipboard: {},
	} as unknown as Platform;
	return { platform, resetSyncState, shell, crypto };
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

describe("createVault sync-reset guard", () => {
	it("resets device sync identity when creating the FIRST vault (clean slate)", async () => {
		const { platform, resetSyncState } = makePlatform(0);
		const getActions = mountActions(platform);
		await act(async () => {}); // flush the registry load

		await act(async () => {
			await expect(getActions().createVault("pw")).rejects.toThrow();
		});

		expect(resetSyncState).toHaveBeenCalledTimes(1);
	});

	it("does NOT reset device sync identity when adding a vault (would wipe a sibling's sync)", async () => {
		const { platform, resetSyncState } = makePlatform(1);
		const getActions = mountActions(platform);
		await act(async () => {}); // flush the registry load

		await act(async () => {
			await expect(getActions().createVault("pw")).rejects.toThrow();
		});

		expect(resetSyncState).not.toHaveBeenCalled();
	});
});

// Issue #27: generateVek() swaps mobile's ONE process-global VEK. On mobile that fires
// onUnlocked -> the sync manager starts a roster session, and it targets whatever vault is
// RECORDED active — still the previous one at that point. The session then merges the old vault's
// file while the global key is the new vault's, sealing entries no slot in that file can unwrap:
// permanent lockout under both the master password and the recovery code. So the new id has to be
// recorded (which also stops any live session) strictly before the key moves.
describe("createVault records the active vault before swapping the VEK", () => {
	it("calls setActiveVault(newId) before generateVek", async () => {
		const { platform, shell, crypto } = makePlatform(1);
		const order: string[] = [];
		shell.setActiveVault.mockImplementation(async (id: string | null) => {
			order.push(`setActiveVault:${id === null ? "null" : "id"}`);
		});
		crypto.generateVek.mockImplementation(async () => {
			order.push("generateVek");
			throw new Error("stop after the guard");
		});
		const getActions = mountActions(platform);
		await act(async () => {});

		await act(async () => {
			await expect(getActions().createVault("pw")).rejects.toThrow();
		});

		expect(order).toEqual(["setActiveVault:id", "generateVek"]);
	});
});
