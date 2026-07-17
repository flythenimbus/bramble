import { Directory, Filesystem } from "@capacitor/filesystem";
import { Preferences } from "@capacitor/preferences";
import type { StorageAdapter } from "@core/index";
import { base64ToBytes, bytesToBase64 } from "@core/util/bytes";
import {
	addVault,
	EMPTY_REGISTRY,
	parseRegistry,
	VAULT_REGISTRY_KEY,
	type VaultRegistry,
} from "@core/vault/vault-registry";

// POC storage: the encrypted VLT1 blob lives on the app-private native filesystem
// (Directory.Data, not webview IndexedDB which iOS evicts). Metadata rides in
// Preferences. NOTE: Preferences is NOT a secure store; once we add the biometric
// + Keychain/Keystore phase, the VEK-wrapping key moves to a secure-storage plugin.
const VAULT_FILE = "vault.vlt1";
const BACKUP_FILE = "vault.vlt1.bak";
const DIR = Directory.Data;

// A vault's blob is a file `vault-<id>.vlt1`, except the first vault (the "legacy blob"
// vault), which stays at `vault.vlt1` so the single-vault -> multi-vault migration moves no
// bytes (and mobile autofill keeps reading the fixed path). See docs/multiple-vaults.md.
function blobFileFor(id: string, reg: VaultRegistry): string {
	return id === reg.legacyBlobVaultId ? VAULT_FILE : `vault-${id}.vlt1`;
}
function backupFileFor(id: string, reg: VaultRegistry): string {
	return id === reg.legacyBlobVaultId ? BACKUP_FILE : `vault-${id}.vlt1.bak`;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await Filesystem.stat({ path, directory: DIR });
		return true;
	} catch {
		return false;
	}
}

async function readRegistry(): Promise<VaultRegistry> {
	const r = await Preferences.get({ key: `meta:${VAULT_REGISTRY_KEY}` });
	return parseRegistry(r.value ? JSON.parse(r.value) : null);
}
async function writeRegistry(reg: VaultRegistry): Promise<void> {
	await Preferences.set({ key: `meta:${VAULT_REGISTRY_KEY}`, value: JSON.stringify(reg) });
}

// Single-vault -> multi-vault migration: register the existing vault (if any) so every vault
// is addressable by id, moving no bytes (the existing vault keeps the fixed file path).
// Idempotent and memoised so it runs once. Mobile has no legacy FSA path.
let migration: Promise<void> | null = null;
function ensureMigrated(): Promise<void> {
	if (!migration) migration = runMigration();
	return migration;
}
async function runMigration(): Promise<void> {
	const existing = await Preferences.get({ key: `meta:${VAULT_REGISTRY_KEY}` });
	if (existing.value != null) return;
	const reg = (await fileExists(VAULT_FILE))
		? addVault(EMPTY_REGISTRY, { id: crypto.randomUUID(), label: "", createdAt: Date.now() })
		: EMPTY_REGISTRY;
	await writeRegistry(reg);
}

export const mobileStorage: StorageAdapter = {
	async hasVaultHandle(vaultId) {
		await ensureMigrated();
		const reg = await readRegistry();
		if (vaultId != null) return fileExists(blobFileFor(vaultId, reg));
		if (reg.vaults.length > 0) return true;
		return fileExists(VAULT_FILE);
	},
	async readVaultBlob(vaultId) {
		await ensureMigrated();
		const reg = await readRegistry();
		const targetId = vaultId ?? reg.legacyBlobVaultId;
		if (targetId == null) throw new Error("no vault stored");
		const r = await Filesystem.readFile({ path: blobFileFor(targetId, reg), directory: DIR });
		return base64ToBytes(r.data as string);
	},
	async writeVaultBlob(blob, vaultId) {
		await ensureMigrated();
		let reg = await readRegistry();
		let targetId = vaultId ?? reg.legacyBlobVaultId;
		if (targetId == null) {
			targetId = crypto.randomUUID();
			reg = addVault(reg, { id: targetId, label: "", createdAt: Date.now() });
			await writeRegistry(reg);
		}
		const path = blobFileFor(targetId, reg);
		// Snapshot the previous good bytes before truncating, so a crash mid-write
		// is recoverable via restoreVaultFromBackup.
		if (await fileExists(path)) {
			const cur = await Filesystem.readFile({ path, directory: DIR });
			await Filesystem.writeFile({
				path: backupFileFor(targetId, reg),
				directory: DIR,
				data: cur.data as string,
			});
		}
		await Filesystem.writeFile({ path, directory: DIR, data: bytesToBase64(blob) });
	},
	async restoreVaultFromBackup(vaultId) {
		await ensureMigrated();
		const reg = await readRegistry();
		const targetId = vaultId ?? reg.legacyBlobVaultId;
		if (targetId == null) return false;
		const bakPath = backupFileFor(targetId, reg);
		if (!(await fileExists(bakPath))) return false;
		const bak = await Filesystem.readFile({ path: bakPath, directory: DIR });
		await Filesystem.writeFile({
			path: blobFileFor(targetId, reg),
			directory: DIR,
			data: bak.data as string,
		});
		return true;
	},
	/** Delete a vault's blob file and recovery snapshot. Idempotent (missing files are skipped). */
	async deleteVaultBlob(vaultId) {
		await ensureMigrated();
		const reg = await readRegistry();
		const path = blobFileFor(vaultId, reg);
		const bak = backupFileFor(vaultId, reg);
		if (await fileExists(path)) await Filesystem.deleteFile({ path, directory: DIR });
		if (await fileExists(bak)) await Filesystem.deleteFile({ path: bak, directory: DIR });
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
};
