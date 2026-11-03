/** @vitest-environment happy-dom */
// Desktop's crypto adapter announces a lock the moment the key is gone (its onExternalLock fires
// inside crypto.lock), which shows the unlock screen while lock() is still clearing the index. If
// the explicit-lock mark landed only after that, the screen mounted thinking this was an auto-lock
// and "Unlock on open" prompted straight after the Lock button.
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import { mountVault } from "../test/vault-harness";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";

afterEach(cleanup);

vi.mock("../vault-format", async (importOriginal) => ({
	...(await importOriginal<typeof import("../vault-format")>()),
	decodeVaultBlob: () => ({
		slots: [
			{
				kind: 0x01,
				slotId: new Uint8Array(16),
				salt: new Uint8Array(16),
				verifier: new Uint8Array(32),
				wrapIv: new Uint8Array(12),
				wrappedVek: new Uint8Array(32),
			},
		],
		entriesIv: new Uint8Array(12),
		entriesCiphertext: new Uint8Array([1]),
	}),
	encodeVaultBlob: () => new Uint8Array([1, 2, 3]),
}));

function makePlatform() {
	const meta = new Map<string, unknown>([
		[VAULT_REGISTRY_KEY, { vaults: [{ id: "vault-1", label: "", createdAt: 1 }] }],
	]);
	let externalLock: (() => void) | undefined;
	let releaseClear: (() => void) | undefined;
	const platform = {
		target: "desktop",
		storage: {
			getMeta: async (k: string) => meta.get(k),
			setMeta: async (k: string, v: unknown) => void meta.set(k, v),
			removeMeta: async (k: string) => void meta.delete(k),
			hasVault: async () => true,
			readVaultBlob: async () => new Uint8Array([1]),
			writeVaultBlob: async () => {},
			restoreVaultFromBackup: async () => false,
			readQuarantine: async () => null,
			writeQuarantine: async () => {},
		},
		crypto: {
			isLocked: async () => false,
			onExternalLock: (cb: () => void) => {
				externalLock = cb;
				return () => {};
			},
			onExternalChange: () => () => {},
			unwrapVekPassword: async () => true,
			decryptWithVek: async () => JSON.stringify({ entries: [], tombstones: [] }),
			decryptEntries: async () => [],
			// As desktop's adapter: the key goes, then the lock is announced, before lock() resumes.
			lock: async () => externalLock?.(),
		},
		autofill: {
			// Held open, so the app sits between "key gone" and the rest of lock().
			clearIndex: () =>
				new Promise<void>((r) => {
					releaseClear = r;
				}),
			setIndex: async () => {},
		},
		shell: {
			setActiveVault: async () => {},
			onSyncStatus: () => () => {},
			flushPendingCornerCapture: async () => false,
		},
		clipboard: {},
	} as unknown as Platform;
	return { platform, release: () => releaseClear?.() };
}

it("marks a Lock-button lock as the user's before the unlock screen can show", async () => {
	const p = makePlatform();
	const m = mountVault(p.platform);
	await waitFor(() => expect(m.actions().unlock).toBeTypeOf("function"));
	await m.actions().unlock("pw");
	await waitFor(() => expect(m.state().isLocked).toBe(false));

	const locking = m.actions().lock();
	await waitFor(() => expect(m.state().isLocked).toBe(true));
	// Still inside lock(): the index clear hasn't returned.
	expect(m.state().lockedByUser).toBe(true);
	p.release();
	await locking;
	expect(m.state().lockedByUser).toBe(true);
});
