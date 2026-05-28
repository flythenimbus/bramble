/// <reference types="chrome" />
import type { StorageAdapter } from "@core/adapters/storage";

const VAULT_BLOB_KEY = "vault-blob-b64";
const VAULT_BLOB_BACKUP_KEY = "vault-blob-backup-b64";
export const PENDING_BLOB_KEY = "vault.pendingFlush";

interface PendingBlobStash {
	blobB64: string;
	entryCount: number;
	queuedAt: number;
}
const IDB_NAME = "vault-storage";
const IDB_STORE = "handles";
const HANDLE_KEY = "vault-file";

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

function bytesToBase64(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
	return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
	const s = atob(b64);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

async function hasLocalVault(): Promise<boolean> {
	const result = await chrome.storage.local.get(VAULT_BLOB_KEY);
	return typeof result[VAULT_BLOB_KEY] === "string";
}

async function readExistingBlobBytes(
	handle: FileSystemFileHandle | null,
): Promise<Uint8Array | null> {
	try {
		if (handle) {
			const file = await handle.getFile();
			if (file.size === 0) return null;
			return new Uint8Array(await file.arrayBuffer());
		}
		const r = await chrome.storage.local.get(VAULT_BLOB_KEY);
		const b64 = r[VAULT_BLOB_KEY];
		if (typeof b64 !== "string" || b64.length === 0) return null;
		return base64ToBytes(b64);
	} catch {
		return null;
	}
}

async function snapshotCurrentBlob(handle: FileSystemFileHandle | null): Promise<void> {
	const existing = await readExistingBlobBytes(handle);
	try {
		if (existing === null) {
			await chrome.storage.local.remove(VAULT_BLOB_BACKUP_KEY);
			return;
		}
		await chrome.storage.local.set({ [VAULT_BLOB_BACKUP_KEY]: bytesToBase64(existing) });
	} catch {
	}
}

const VAULT_FILE_TYPES = [
	{
		description: `${chrome.runtime.getManifest().name} vault`,
		accept: { "application/octet-stream": [".db"] },
	},
];

export const extensionStorage: StorageAdapter = {
	async hasVaultHandle() {
		const handle = await getHandle();
		if (handle) return true;
		return hasLocalVault();
	},

	async selectVaultFile(mode) {
		if (!pickerSupported()) {
			throw new Error(
				"File picker not available in this browser context — vault will use browser storage instead.",
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

	async readVaultBlob() {
		const handle = await getHandle();
		if (handle) {
			await ensurePermission(handle);
			const file = await handle.getFile();
			return new Uint8Array(await file.arrayBuffer());
		}
		const result = await chrome.storage.local.get(VAULT_BLOB_KEY);
		const b64 = result[VAULT_BLOB_KEY];
		if (typeof b64 !== "string") throw new Error("no vault stored");
		return base64ToBytes(b64);
	},

	async writeVaultBlob(blob) {
		const handle = await getHandle();
		await snapshotCurrentBlob(handle);
		if (handle) {
			await ensurePermission(handle);
			const writable = await handle.createWritable();
			await writable.write(blob as BufferSource);
			await writable.close();
			return;
		}
		await chrome.storage.local.set({ [VAULT_BLOB_KEY]: bytesToBase64(blob) });
	},

	async restoreVaultFromBackup() {
		const r = await chrome.storage.local.get(VAULT_BLOB_BACKUP_KEY);
		const b64 = r[VAULT_BLOB_BACKUP_KEY];
		if (typeof b64 !== "string" || b64.length === 0) return false;
		const bytes = base64ToBytes(b64);
		const handle = await getHandle();
		if (handle) {
			await ensurePermission(handle);
			const writable = await handle.createWritable();
			await writable.write(bytes as BufferSource);
			await writable.close();
		} else {
			await chrome.storage.local.set({ [VAULT_BLOB_KEY]: b64 });
		}
		return true;
	},

	async getMeta(key) {
		const result = await chrome.storage.local.get(key);
		return result[key];
	},

	async setMeta(key, value) {
		await chrome.storage.local.set({ [key]: value });
	},

	async canWriteFromBackground() {
		return (await getHandle()) === null;
	},

	async flushPendingVaultBlob() {
		const result = await chrome.storage.session.get(PENDING_BLOB_KEY);
		const stash = result[PENDING_BLOB_KEY] as PendingBlobStash | undefined;
		if (!stash || typeof stash.blobB64 !== "string") return false;
		const bytes = base64ToBytes(stash.blobB64);
		await extensionStorage.writeVaultBlob(bytes);
		await chrome.storage.session.remove(PENDING_BLOB_KEY);
		return true;
	},

	async getPendingFlushCount() {
		const result = await chrome.storage.session.get(PENDING_BLOB_KEY);
		const stash = result[PENDING_BLOB_KEY] as PendingBlobStash | undefined;
		if (!stash) return 0;
		return typeof stash.entryCount === "number" ? stash.entryCount : 0;
	},
};
