/// <reference types="chrome" />

import type { StorageAdapter } from "@core/adapters/storage";
import { base64ToBytes, bytesToBase64 } from "@core/util/bytes";
import { api } from "./platform-api";

const VAULT_BLOB_KEY = "vault-blob-b64";
/** Recovery snapshot of the previous on-disk vault bytes, written before truncate so a crash leaves a recoverable backup. */
const VAULT_BLOB_BACKUP_KEY = "vault-blob-backup-b64";
/** Corner-prompt write queue: the background stashes ciphertext here when it can't reach an FSA file; the next popup/options mount flushes it. */
export const PENDING_BLOB_KEY = "vault.pendingFlush";

/** Queued corner-prompt write: the full vault ciphertext plus metadata for the flush UI. */
interface PendingBlobStash {
	blobB64: string;
	entryCount: number;
	queuedAt: number;
}
const IDB_NAME = "vault-storage";
const IDB_STORE = "handles";
const HANDLE_KEY = "vault-file";

/** pickerSupported gates picking a new file, NOT reading the handle (SW can read from IndexedDB). */
function pickerSupported(): boolean {
	if (typeof window === "undefined") return false;
	return (
		typeof window.showSaveFilePicker === "function" &&
		typeof window.showOpenFilePicker === "function"
	);
}

async function openIdb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(IDB_NAME, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function getHandle(): Promise<FileSystemFileHandle | null> {
	const db = await openIdb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(HANDLE_KEY);
		tx.onsuccess = () => resolve((tx.result as FileSystemFileHandle | undefined) ?? null);
		tx.onerror = () => reject(tx.error);
	});
}

async function putHandle(handle: FileSystemFileHandle): Promise<void> {
	const db = await openIdb();
	return new Promise((resolve, reject) => {
		const tx = db
			.transaction(IDB_STORE, "readwrite")
			.objectStore(IDB_STORE)
			.put(handle, HANDLE_KEY);
		tx.onsuccess = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

async function ensurePermission(handle: FileSystemFileHandle): Promise<void> {
	const state = await handle.queryPermission({ mode: "readwrite" });
	if (state === "granted") return;
	const result = await handle.requestPermission({ mode: "readwrite" });
	if (result !== "granted") {
		throw new Error("permission denied for vault file");
	}
}

async function hasLocalVault(): Promise<boolean> {
	const result = await api.storage.local.get(VAULT_BLOB_KEY);
	return typeof result[VAULT_BLOB_KEY] === "string";
}

/** Read the bytes in the vault target (FSA file or chrome.storage.local). Any error returns null so the pre-write snapshot degrades to "no backup" instead of blocking the write. */
async function readExistingBlobBytes(
	handle: FileSystemFileHandle | null,
): Promise<Uint8Array | null> {
	try {
		if (handle) {
			const file = await handle.getFile();
			if (file.size === 0) return null;
			return new Uint8Array(await file.arrayBuffer());
		}
		const r = await api.storage.local.get(VAULT_BLOB_KEY);
		const b64 = r[VAULT_BLOB_KEY];
		if (typeof b64 !== "string" || b64.length === 0) return null;
		return base64ToBytes(b64);
	} catch {
		return null;
	}
}

/** Snapshot current on-disk bytes into the backup key before truncating. On vault creation (nothing on disk), clear any stale backup so we can't restore over a fresh vault. */
async function snapshotCurrentBlob(handle: FileSystemFileHandle | null): Promise<void> {
	const existing = await readExistingBlobBytes(handle);
	try {
		if (existing === null) {
			await api.storage.local.remove(VAULT_BLOB_BACKUP_KEY);
			return;
		}
		await api.storage.local.set({ [VAULT_BLOB_BACKUP_KEY]: bytesToBase64(existing) });
	} catch {
		// Best-effort: failing the write because the backup failed would block all saves.
	}
}

/** File-picker description follows the host brand (manifest.json `name`, same as shell.appName). */
const VAULT_FILE_TYPES = [
	{
		description: `${api.runtime.getManifest().name} vault`,
		accept: { "application/octet-stream": [".db"] },
	},
];

export const extensionStorage: StorageAdapter = {
	/** True when a vault exists: a stored FSA handle or a chrome.storage.local blob. */
	async hasVaultHandle() {
		const handle = await getHandle();
		if (handle) return true;
		return hasLocalVault();
	},

	/** Prompt for an FSA vault file (create or open) and persist its handle. Throws when no picker is available. */
	async selectVaultFile(mode) {
		if (!pickerSupported()) {
			throw new Error(
				"File picker not available in this browser context. Vault will use browser storage instead.",
			);
		}
		const handle =
			mode === "create"
				? await window.showSaveFilePicker({
						suggestedName: "vault.db",
						types: VAULT_FILE_TYPES,
					})
				: (await window.showOpenFilePicker({ types: VAULT_FILE_TYPES }))[0];
		if (!handle) throw new Error("no file selected");
		await putHandle(handle);
	},

	/** Grant FSA read/write permission up front (within a user gesture) so later reads/writes in the same flow don't prompt. No-op without an FSA handle. */
	async requestVaultAccess() {
		const handle = await getHandle();
		if (handle) await ensurePermission(handle);
	},

	/** Read the vault bytes from the FSA file or the chrome.storage.local fallback. Throws when no vault is stored. */
	async readVaultBlob() {
		const handle = await getHandle();
		if (handle) {
			await ensurePermission(handle);
			const file = await handle.getFile();
			return new Uint8Array(await file.arrayBuffer());
		}
		const result = await api.storage.local.get(VAULT_BLOB_KEY);
		const b64 = result[VAULT_BLOB_KEY];
		if (typeof b64 !== "string") throw new Error("no vault stored");
		return base64ToBytes(b64);
	},

	/** Write the vault bytes to the FSA file or chrome.storage.local, taking a recoverable backup first. */
	async writeVaultBlob(blob) {
		const handle = await getHandle();
		// Snapshot before createWritable() truncates, so a crash leaves a recoverable backup.
		await snapshotCurrentBlob(handle);
		if (handle) {
			await ensurePermission(handle);
			const writable = await handle.createWritable();
			await writable.write(blob as BufferSource);
			await writable.close();
			return;
		}
		await api.storage.local.set({ [VAULT_BLOB_KEY]: bytesToBase64(blob) });
	},

	/** Restore the last pre-write backup over the live vault. Returns false when no backup exists. */
	async restoreVaultFromBackup() {
		const r = await api.storage.local.get(VAULT_BLOB_BACKUP_KEY);
		const b64 = r[VAULT_BLOB_BACKUP_KEY];
		if (typeof b64 !== "string" || b64.length === 0) return false;
		const bytes = base64ToBytes(b64);
		const handle = await getHandle();
		// Skip snapshotCurrentBlob deliberately: overwriting the backup with the corrupt live file would discard our only good copy.
		if (handle) {
			await ensurePermission(handle);
			const writable = await handle.createWritable();
			await writable.write(bytes as BufferSource);
			await writable.close();
		} else {
			await api.storage.local.set({ [VAULT_BLOB_KEY]: b64 });
		}
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

	/** True when the background can write the vault directly. chrome.storage.local always can; an FSA file can iff its read/write permission is already granted (createWritable itself needs no gesture, only requestPermission does). Otherwise the background queues for the next popup to flush. */
	async canWriteFromBackground() {
		const handle = await getHandle();
		if (handle === null) return true;
		return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
	},

	/** Write through a queued corner-prompt blob (PENDING_BLOB_KEY) and clear it. Returns false when nothing is queued. */
	async flushPendingVaultBlob() {
		const result = await api.storage.session.get(PENDING_BLOB_KEY);
		const stash = result[PENDING_BLOB_KEY] as PendingBlobStash | undefined;
		if (!stash || typeof stash.blobB64 !== "string") return false;
		const bytes = base64ToBytes(stash.blobB64);
		await extensionStorage.writeVaultBlob(bytes);
		await api.storage.session.remove(PENDING_BLOB_KEY);
		return true;
	},

	/** Number of entries in the queued corner-prompt blob, or 0 when none is queued. */
	async getPendingFlushCount() {
		const result = await api.storage.session.get(PENDING_BLOB_KEY);
		const stash = result[PENDING_BLOB_KEY] as PendingBlobStash | undefined;
		if (!stash) return 0;
		return typeof stash.entryCount === "number" ? stash.entryCount : 0;
	},
};
