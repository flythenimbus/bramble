/// <reference types="chrome" />
import type { StorageAdapter } from "@core/adapters/storage";

const DB_NAME = "vault-handle";
const STORE = "handles";
const HANDLE_KEY = "vault-file";

async function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function getHandle(): Promise<FileSystemFileHandle | undefined> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(HANDLE_KEY);
		tx.onsuccess = () => resolve(tx.result as FileSystemFileHandle | undefined);
		tx.onerror = () => reject(tx.error);
	});
}

async function putHandle(handle: FileSystemFileHandle): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite").objectStore(STORE).put(handle, HANDLE_KEY);
		tx.onsuccess = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

async function ensurePermission(handle: FileSystemFileHandle): Promise<void> {
	// @ts-expect-error queryPermission is non-standard but Chromium supports it
	const state = await handle.queryPermission({ mode: "readwrite" });
	if (state === "granted") return;
	// @ts-expect-error requestPermission is non-standard but Chromium supports it
	const result = await handle.requestPermission({ mode: "readwrite" });
	if (result !== "granted") throw new Error("permission denied for vault file");
}

export const extensionStorage: StorageAdapter = {
	async hasVaultHandle() {
		return Boolean(await getHandle());
	},

	async selectVaultFile(mode) {
		const handle =
			mode === "create"
				? await window.showSaveFilePicker({ suggestedName: "vault.db" })
				: (await window.showOpenFilePicker({ multiple: false }))[0];
		if (!handle) throw new Error("no file selected");
		await putHandle(handle);
	},

	async readVaultBlob() {
		const handle = await getHandle();
		if (!handle) throw new Error("no vault file selected");
		await ensurePermission(handle);
		const file = await handle.getFile();
		return new Uint8Array(await file.arrayBuffer());
	},

	async writeVaultBlob(blob) {
		const handle = await getHandle();
		if (!handle) throw new Error("no vault file selected");
		await ensurePermission(handle);
		const writable = await handle.createWritable();
		await writable.write(blob as BufferSource);
		await writable.close();
	},

	async getMeta(key) {
		const result = await chrome.storage.local.get(key);
		return result[key];
	},

	async setMeta(key, value) {
		await chrome.storage.local.set({ [key]: value });
	},
};
