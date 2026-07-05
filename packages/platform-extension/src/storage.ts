/// <reference types="chrome" />

import type { StorageAdapter } from "@core/adapters/storage";
import { base64ToBytes, bytesToBase64 } from "@core/util/bytes";
import { api } from "./platform-api";
import { clearLegacyHandle, getLegacyHandle } from "./storage-legacy";

const VAULT_BLOB_KEY = "vault-blob-b64";
/** Recovery snapshot of the previous vault bytes, written before every overwrite so a crash mid-write leaves a recoverable copy. */
const VAULT_BLOB_BACKUP_KEY = "vault-blob-backup-b64";

// --- Legacy File System Access migration ---
// Pre-migration vaults lived in a real file (an FSA handle in IndexedDB), which required a
// user gesture to (re)grant permission on every service-worker restart - hostile UX under
// MV3 (the SW dies every ~30s and the permission lapses). The vault now lives in
// chrome.storage.local: the extension's own sandbox, which needs no gesture, survives SW
// restarts, and is readable/writable headless. An existing file-backed vault is migrated
// into local storage on the first unlock (a real click, so the one-time file read is
// permitted); the original file is left on disk as the user's own backup. The IndexedDB
// handle glue lives in ./storage-legacy; this whole path can be deleted once no file-backed
// installs remain.

/**
 * Copy a legacy file-backed vault into local storage. MUST run inside a user gesture (the
 * file read may prompt for permission). Writes local storage first, then drops the handle,
 * so a crash mid-migration just re-migrates next time. The file itself is never modified or
 * deleted - it stays as the user's backup.
 */
async function migrateLegacyVault(handle: FileSystemFileHandle): Promise<Uint8Array> {
	if ((await handle.queryPermission({ mode: "read" })) !== "granted") {
		if ((await handle.requestPermission({ mode: "read" })) !== "granted") {
			throw new Error("permission denied for vault file");
		}
	}
	const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
	await api.storage.local.set({ [VAULT_BLOB_KEY]: bytesToBase64(bytes) });
	await clearLegacyHandle();
	return bytes;
}

async function localVaultBytes(): Promise<Uint8Array | null> {
	const r = await api.storage.local.get(VAULT_BLOB_KEY);
	const b64 = r[VAULT_BLOB_KEY];
	return typeof b64 === "string" && b64.length > 0 ? base64ToBytes(b64) : null;
}

/** Snapshot the current vault bytes into the backup key before an overwrite; clear the backup on the first write (nothing to recover) so we can't later restore over a freshly created vault. */
async function snapshotCurrentBlob(): Promise<void> {
	try {
		const existing = await localVaultBytes();
		if (existing === null) {
			await api.storage.local.remove(VAULT_BLOB_BACKUP_KEY);
			return;
		}
		await api.storage.local.set({ [VAULT_BLOB_BACKUP_KEY]: bytesToBase64(existing) });
	} catch {
		// Best-effort: failing the write because the backup failed would block all saves.
	}
}

export const extensionStorage: StorageAdapter = {
	/** True when a vault exists: a chrome.storage.local blob, or a not-yet-migrated legacy file. */
	async hasVaultHandle() {
		if ((await localVaultBytes()) !== null) return true;
		return (await getLegacyHandle()) !== null;
	},

	/** Read the vault bytes from chrome.storage.local, migrating a legacy file-backed vault on first read (inside the unlock gesture). Throws when no vault is stored. */
	async readVaultBlob() {
		const local = await localVaultBytes();
		if (local !== null) return local;
		const handle = await getLegacyHandle();
		if (handle) return migrateLegacyVault(handle);
		throw new Error("no vault stored");
	},

	/** Write the vault bytes to chrome.storage.local, snapshotting a recoverable backup first. */
	async writeVaultBlob(blob) {
		await snapshotCurrentBlob();
		await api.storage.local.set({ [VAULT_BLOB_KEY]: bytesToBase64(blob) });
	},

	/** Restore the last pre-write backup over the live vault. Returns false when no backup exists. */
	async restoreVaultFromBackup() {
		const r = await api.storage.local.get(VAULT_BLOB_BACKUP_KEY);
		const b64 = r[VAULT_BLOB_BACKUP_KEY];
		if (typeof b64 !== "string" || b64.length === 0) return false;
		await api.storage.local.set({ [VAULT_BLOB_KEY]: b64 });
		return true;
	},

	/** Read a plaintext metadata value from chrome.storage.local. */
	async getMeta(key) {
		const result = await api.storage.local.get(key);
		return result[key];
	},

	/** Write a plaintext metadata value to chrome.storage.local. */
	async setMeta(key, value) {
		await api.storage.local.set({ [key]: value });
	},

	/** Delete a metadata key from chrome.storage.local. */
	async removeMeta(key) {
		await api.storage.local.remove(key);
	},
};
