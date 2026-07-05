import { Directory, Filesystem } from "@capacitor/filesystem";
import { Preferences } from "@capacitor/preferences";
import type { StorageAdapter } from "@core/index";
import { base64ToBytes, bytesToBase64 } from "@core/util/bytes";

// POC storage: the encrypted VLT1 blob lives on the app-private native filesystem
// (Directory.Data, not webview IndexedDB which iOS evicts). Metadata rides in
// Preferences. NOTE: Preferences is NOT a secure store; once we add the biometric
// + Keychain/Keystore phase, the VEK-wrapping key moves to a secure-storage plugin.
const VAULT_FILE = "vault.vlt1";
const BACKUP_FILE = "vault.vlt1.bak";
const DIR = Directory.Data;

async function fileExists(path: string): Promise<boolean> {
	try {
		await Filesystem.stat({ path, directory: DIR });
		return true;
	} catch {
		return false;
	}
}

export const mobileStorage: StorageAdapter = {
	async hasVaultHandle() {
		return fileExists(VAULT_FILE);
	},
	// No native file picker: the vault is app-managed. "create" is satisfied by the
	// first writeVaultBlob; "open" is a no-op when the managed file already exists.
	async selectVaultFile() {},
	async requestVaultAccess() {},

	async readVaultBlob() {
		const r = await Filesystem.readFile({ path: VAULT_FILE, directory: DIR });
		return base64ToBytes(r.data as string);
	},
	async writeVaultBlob(blob) {
		// Snapshot the previous good bytes before truncating, so a crash mid-write
		// is recoverable via restoreVaultFromBackup.
		if (await fileExists(VAULT_FILE)) {
			const cur = await Filesystem.readFile({ path: VAULT_FILE, directory: DIR });
			await Filesystem.writeFile({ path: BACKUP_FILE, directory: DIR, data: cur.data as string });
		}
		await Filesystem.writeFile({ path: VAULT_FILE, directory: DIR, data: bytesToBase64(blob) });
	},
	async restoreVaultFromBackup() {
		if (!(await fileExists(BACKUP_FILE))) return false;
		const bak = await Filesystem.readFile({ path: BACKUP_FILE, directory: DIR });
		await Filesystem.writeFile({ path: VAULT_FILE, directory: DIR, data: bak.data as string });
		return true;
	},

	async getMeta<T>(key: string): Promise<T | undefined> {
		const r = await Preferences.get({ key: `meta:${key}` });
		return r.value ? (JSON.parse(r.value) as T) : undefined;
	},
	async setMeta<T>(key: string, value: T): Promise<void> {
		await Preferences.set({ key: `meta:${key}`, value: JSON.stringify(value) });
	},
	async removeMeta(key: string): Promise<void> {
		await Preferences.remove({ key: `meta:${key}` });
	},

	// Single foreground context for the POC: no background writer, no stash.
	async canWriteFromBackground() {
		return true;
	},
	async canReadFromBackground() {
		return true;
	},
	async flushPendingVaultBlob() {
		return false;
	},
	async getPendingFlushCount() {
		return 0;
	},
};
