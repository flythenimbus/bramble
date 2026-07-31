/** @vitest-environment happy-dom */
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import { PER_VAULT_SYNC_KEYS } from "../sync/sync-keys";
import { mountVaultActions } from "../test/vault-harness";
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
	const autofill = {
		clearIndex: vi.fn(async () => {}),
		setIndex: vi.fn(async () => {}),
		clearProviderData: vi.fn(async () => {}),
	};
	const biometric = {
		isAvailable: vi.fn(async () => false),
		isEnabled: vi.fn(async () => false),
		disable: vi.fn(async (_id: string) => {}),
	};
	const platform = {
		storage,
		crypto,
		autofill,
		biometric,
		shell,
		clipboard: {},
	} as unknown as Platform;
	return { platform, shell, storage, crypto, autofill, biometric };
}

describe("deleteVault clears the recorded active vault", () => {
	it("erases the blob and then clears the active id", async () => {
		const { platform, shell, storage } = makePlatform();
		const getActions = mountVaultActions(platform);
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
		const getActions = mountVaultActions(platform);
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

// Erasing the blob is not enough: the mobile provider's mirror is an openable copy of the vault
// (bundle + slot), and the biometric item is the key that opens it. Both survived a delete, and
// neither is namespaced in a way that anything else would reclaim.
describe("deleteVault erases everything else keyed to the vault", () => {
	it("clears the provider mirror, the biometric item, and the per-vault sync keys", async () => {
		const { platform, storage, autofill, biometric } = makePlatform();
		const getActions = mountVaultActions(platform);
		await act(async () => {});

		await act(async () => {
			await getActions().deleteVault({ password: "pw" });
		});

		expect(autofill.clearProviderData).toHaveBeenCalled();
		expect(biometric.disable).toHaveBeenCalledWith(VAULT_ID);
		for (const k of PER_VAULT_SYNC_KEYS) {
			expect(storage.removeMeta).toHaveBeenCalledWith(`${k}:${VAULT_ID}`);
		}
	});

	it("does none of it when re-auth fails", async () => {
		const { platform, crypto, autofill, biometric } = makePlatform();
		crypto.verifyPasswordSlot.mockResolvedValue(false);
		const getActions = mountVaultActions(platform);
		await act(async () => {});

		await act(async () => {
			await getActions().deleteVault({ password: "wrong" });
		});

		expect(autofill.clearProviderData).not.toHaveBeenCalled();
		expect(biometric.disable).not.toHaveBeenCalled();
	});

	// The bytes are already gone by then, so a native plugin that throws must not strand a
	// half-deleted vault: the registry record and active id still have to be cleared.
	it("still finishes the delete when a native cleanup call throws", async () => {
		const { platform, shell, autofill, biometric } = makePlatform();
		autofill.clearProviderData.mockRejectedValue(new Error("no plugin"));
		biometric.disable.mockRejectedValue(new Error("keychain -34018"));
		const getActions = mountVaultActions(platform);
		await act(async () => {});

		let ok: boolean | undefined;
		await act(async () => {
			ok = await getActions().deleteVault({ password: "pw" });
		});

		expect(ok).toBe(true);
		expect(shell.setActiveVault).toHaveBeenLastCalledWith(null);
	});
});
