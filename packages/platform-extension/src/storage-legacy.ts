/// <reference types="chrome" />

// Legacy File System Access migration glue. Pre-migration vaults lived in a real file whose
// handle was persisted in IndexedDB; this reads (and clears) that handle so storage.ts can
// migrate the file into chrome.storage.local on first unlock. Split out so the migration is
// testable in isolation and so the whole legacy path can be deleted once no file-backed
// installs remain. See docs/storage.md.

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

/** The persisted pre-migration vault file handle, or null (also null on any IndexedDB error). */
export async function getLegacyHandle(): Promise<FileSystemFileHandle | null> {
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

/** Drop the persisted handle once its file has been migrated into local storage. Best-effort. */
export async function clearLegacyHandle(): Promise<void> {
	try {
		const db = await openIdb();
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).delete(HANDLE_KEY);
			tx.onsuccess = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	} catch {
		// A stale handle is harmless once a local vault exists (local wins in readVaultBlob).
	}
}
