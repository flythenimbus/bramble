/** @vitest-environment happy-dom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../context/PlatformContext";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";
import {
	encodeVaultBlob,
	LEN_IV,
	LEN_SALT,
	LEN_SLOT_ID,
	LEN_VERIFIER,
	LEN_WRAP_IV,
	LEN_WRAPPED_VEK,
	type PasswordSlot,
	SLOT_KIND_PASSWORD,
} from "../vault-format";
import { useVaultActions, VaultProvider } from "./useVault";
import { VaultRegistryProvider } from "./useVaultRegistry";

afterEach(cleanup);

// Issue #27: the recorded active vault is sticky — the effect in useVault only ever WRITES it, so
// after deleting a vault it still named the one just erased. Mobile's sync manager resolves its
// target vault from that key, so a later session pointed at a dead id (and, before the fallback was
// removed, at some other vault's file). Deleting must clear it.

const VAULT_ID = "v0";

// A syntactically valid single-slot vault: deleteVault re-auths, which decodes the blob and looks
// for a password slot. Contents don't matter — crypto.verifyPasswordSlot is stubbed.
const fill = (n: number, b: number) => Uint8Array.from({ length: n }, (_, i) => (b + i) & 0xff);
const passwordSlot = (): PasswordSlot => ({
	kind: SLOT_KIND_PASSWORD,
	slotId: fill(LEN_SLOT_ID, 0x10),
	salt: fill(LEN_SALT, 0x20),
	verifier: fill(LEN_VERIFIER, 0x30),
	wrapIv: fill(LEN_WRAP_IV, 0x40),
	wrappedVek: fill(LEN_WRAPPED_VEK, 0x50),
});
const vaultBytes = () =>
	encodeVaultBlob({
		slots: [passwordSlot()],
		entriesIv: fill(LEN_IV, 0x70),
		entriesCiphertext: new Uint8Array(0),
	});

function makePlatform() {
	const registry = { vaults: [{ id: VAULT_ID, label: "", createdAt: 1 }] };
	const shell = {
		setActiveVault: vi.fn(async (_id: string | null) => {}),
		getActiveVault: vi.fn(async () => VAULT_ID),
		resetSyncState: vi.fn(async () => {}),
		flushPendingCornerCapture: vi.fn(async () => {}),
	};
	const storage = {
		hasVaultHandle: vi.fn(async () => false), // mount effect returns early
		getMeta: vi.fn(async (k: string) => (k === VAULT_REGISTRY_KEY ? registry : undefined)),
		setMeta: vi.fn(async () => {}),
		removeMeta: vi.fn(async () => {}),
		readVaultBlob: vi.fn(async () => vaultBytes()),
		restoreVaultFromBackup: vi.fn(async () => false),
		writeVaultBlob: vi.fn(async () => {}),
		deleteVaultBlob: vi.fn(async (_id: string) => {}),
	};
	const crypto = {
		isLocked: vi.fn(async () => true),
		lock: vi.fn(async () => {}),
		onExternalLock: vi.fn(() => () => {}),
		onExternalChange: vi.fn(() => () => {}),
		// Re-auth gate: deleteVault only proceeds when this passes.
		verifyPasswordSlot: vi.fn(async () => true),
		decryptEntries: vi.fn(async () => []),
		decryptWithVek: vi.fn(async () => JSON.stringify({ entries: [], tombstones: [] })),
		unwrapVekPassword: vi.fn(async () => true),
	};
	const platform = {
		storage,
		crypto,
		autofill: { clearIndex: vi.fn(async () => {}), setIndex: vi.fn(async () => {}) },
		shell,
		clipboard: {},
	} as unknown as Platform;
	return { platform, shell, storage, crypto };
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

describe("deleteVault clears the recorded active vault", () => {
	it("erases the blob and then clears the active id", async () => {
		const { platform, shell, storage } = makePlatform();
		const getActions = mountActions(platform);
		await act(async () => {}); // flush the registry load

		let ok: boolean | undefined;
		await act(async () => {
			ok = await getActions().deleteVault({ password: "pw" });
		});

		expect(ok).toBe(true);
		expect(storage.deleteVaultBlob).toHaveBeenCalledWith(VAULT_ID);
		expect(shell.setActiveVault).toHaveBeenLastCalledWith(null);
	});

	it("leaves the active id alone when re-auth fails (nothing was deleted)", async () => {
		const { platform, shell, storage, crypto } = makePlatform();
		crypto.verifyPasswordSlot.mockResolvedValue(false);
		const getActions = mountActions(platform);
		await act(async () => {});

		let ok: boolean | undefined;
		await act(async () => {
			ok = await getActions().deleteVault({ password: "wrong" });
		});

		expect(ok).toBe(false);
		expect(storage.deleteVaultBlob).not.toHaveBeenCalled();
		expect(shell.setActiveVault).not.toHaveBeenCalledWith(null);
	});
});
