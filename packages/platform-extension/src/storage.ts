/// <reference types="chrome" />

import type { StorageAdapter } from "@core/adapters/storage";
import { base64ToBytes, bytesToBase64 } from "@core/util/bytes";
import { api } from "./platform-api";

const VAULT_BLOB_KEY = "vault-blob-b64";
/** Recovery snapshot of the previous vault bytes, written before every overwrite so a crash mid-write leaves a recoverable copy. */
const VAULT_BLOB_BACKUP_KEY = "vault-blob-backup-b64";
/**
 * Legacy corner-prompt write queue. Retained as a no-op flush target: with the
 * chrome.storage.local backend the background always writes directly, so nothing is ever
 * queued. Kept so existing importers (vault-io) resolve.
 */
export const PENDING_BLOB_KEY = "vault.pendingFlush";

// --- Legacy File System Access migration ---
// Pre-migration vaults lived in a real file (an FSA handle in IndexedDB), which required a
// user gesture to (re)grant permission on every service-worker restart - hostile UX under
// MV3 (the SW dies every ~30s and the permission lapses). The vault now lives in
// chrome.storage.local: the extension's own sandbox, which needs no gesture, survives SW
// restarts, and is readable/writable headless. An existing file-backed vault is migrated
// into local storage on the first unlock (a real click, so the one-time file read is
// permitted); the original file is left on disk as the user's own backup. This block is
// read-only legacy support and can be deleted once no file-backed installs remain.
const IDB_NAME = "vault-storage";
const IDB_STORE = "handles";
const HANDLE_KEY = "vault-file";

async function openIdb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(IDB_NAME, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function getLegacyHandle(): Promise<FileSystemFileHandle | null> {
	try {
		const db = await openIdb();
		return await new Promise((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(HANDLE_KEY);
			tx.onsuccess = () => resolve((tx.result as FileSystemFileHandle | undefined) ?? null);
			tx.onerror = () => reject(tx.error);
		});
	} catch {
		return null;
	}
}

async function clearLegacyHandle(): Promise<void> {
	try {
		const db = await openIdb();
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).delete(HANDLE_KEY);
			tx.onsuccess = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	} catch {
		// Best-effort: a stale handle is harmless once a local vault exists (local wins below).
	}
}

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

	/** No-op: the vault lives in chrome.storage.local, so there is no file to pick. Kept for the adapter contract. */
	async selectVaultFile() {},

	/** No-op: chrome.storage.local needs no permission grant. Kept for the adapter contract. */
	async requestVaultAccess() {},

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

	// chrome.storage.local is always readable/writable headless: no gesture, survives SW
	// restarts. So the background never needs to queue or route through the popup.
	async canWriteFromBackground() {
		return true;
	},
	async canReadFromBackground() {
		return true;
	},

	// The pending-blob queue is dead with the local backend (writes always go through
	// directly), so these are no-ops kept for the adapter contract and the popup-mount call.
	async flushPendingVaultBlob() {
		return false;
	},
	async getPendingFlushCount() {
		return 0;
	},
};
