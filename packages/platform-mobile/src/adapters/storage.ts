import { Directory, Filesystem } from "@capacitor/filesystem";
import { Preferences } from "@capacitor/preferences";
import type { StorageAdapter } from "@core/index";
import { PER_VAULT_SYNC_KEYS } from "@core/sync/sync-keys";
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

// Every vault is addressed by id: its blob is the file `vault-<id>.vlt1`. (A pre-namespacing vault's
// blob sat at the fixed `vault.vlt1`; the one-time migration copies it to `vault-<id>.vlt1`.)
function blobFileFor(id: string): string {
	return `vault-${id}.vlt1`;
}
function backupFileFor(id: string): string {
	return `vault-${id}.vlt1.bak`;
}
/** A per-vault sync value's Preferences key: `meta:<base>:<id>`. */
function syncMetaKey(base: string, id: string): string {
	return `meta:${base}:${id}`;
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

// One-time migration to the uniform per-vault namespace, mirroring the extension: a pre-namespacing
// vault's blob file + sync keys sat at the fixed paths; this COPIES them to their `<...>-<id>` /
// `:<id>` names (never a move - the fixed paths stay authoritative until the copy is done and the
// registry cut over), then deletes them. Crash-safe (copy -> registry cutover -> delete) and
// concurrency-safe (copies only what still exists). Memoised so it runs once. Mobile has no legacy
// FSA path. See docs/multiple-vaults.md.
let migration: Promise<void> | null = null;
function ensureMigrated(): Promise<void> {
	if (!migration) migration = runMigration();
	return migration;
}
async function runMigration(): Promise<void> {
	const rawStr = (await Preferences.get({ key: `meta:${VAULT_REGISTRY_KEY}` })).value;
	if (rawStr != null) {
		// A registry exists. Finish namespacing a vault it still points at the fixed paths via the
		// retired `legacyBlobVaultId` (raw-read; parseRegistry strips it).
		const raw = JSON.parse(rawStr) as { legacyBlobVaultId?: unknown };
		const flatId = typeof raw.legacyBlobVaultId === "string" ? raw.legacyBlobVaultId : null;
		if (flatId == null) return; // already uniform
		await copyFlatVaultToNamespaced(flatId);
		await writeRegistry(parseRegistry(raw)); // cutover: registry without legacyBlobVaultId
		await deleteFlatVaultKeys();
		return;
	}
	if (!(await fileExists(VAULT_FILE))) {
		await writeRegistry(EMPTY_REGISTRY);
		return;
	}
	const id = crypto.randomUUID();
	await copyFlatVaultToNamespaced(id);
	await writeRegistry(addVault(EMPTY_REGISTRY, { id, label: "", createdAt: Date.now() }));
	await deleteFlatVaultKeys();
}

async function copyFileIfExists(from: string, to: string): Promise<void> {
	if (!(await fileExists(from))) return;
	const r = await Filesystem.readFile({ path: from, directory: DIR });
	await Filesystem.writeFile({ path: to, directory: DIR, data: r.data as string });
}

/** Copy a pre-namespacing vault's fixed-path blob (+ snapshot) and sync keys to their `<...>-<id>` /
 * `:<id>` names. Copies only what still exists, so a racing context can't clobber a namespaced value
 * once it deleted the fixed one. Preserves values byte-for-byte, so the sync identity stays paired. */
async function copyFlatVaultToNamespaced(id: string): Promise<void> {
	await copyFileIfExists(VAULT_FILE, blobFileFor(id));
	await copyFileIfExists(BACKUP_FILE, backupFileFor(id));
	for (const base of PER_VAULT_SYNC_KEYS) {
		const v = (await Preferences.get({ key: `meta:${base}` })).value;
		if (v != null) await Preferences.set({ key: syncMetaKey(base, id), value: v });
	}
}

/** Delete the fixed-path blob, snapshot, and sync keys after the cutover. Best-effort: any left
 * behind are unread orphans. */
async function deleteFlatVaultKeys(): Promise<void> {
	if (await fileExists(VAULT_FILE))
		await Filesystem.deleteFile({ path: VAULT_FILE, directory: DIR });
	if (await fileExists(BACKUP_FILE))
		await Filesystem.deleteFile({ path: BACKUP_FILE, directory: DIR });
	for (const base of PER_VAULT_SYNC_KEYS) await Preferences.remove({ key: `meta:${base}` });
}

export const mobileStorage: StorageAdapter = {
	async hasVaultHandle(vaultId) {
		await ensureMigrated();
		const reg = await readRegistry();
		if (vaultId != null) return fileExists(blobFileFor(vaultId));
		return reg.vaults.length > 0;
	},
	async readVaultBlob(vaultId) {
		await ensureMigrated();
		const reg = await readRegistry();
		const targetId = vaultId ?? reg.vaults[0]?.id;
		if (targetId == null) throw new Error("no vault stored");
		const r = await Filesystem.readFile({ path: blobFileFor(targetId), directory: DIR });
		return base64ToBytes(r.data as string);
	},
	async writeVaultBlob(blob, vaultId) {
		await ensureMigrated();
		let reg = await readRegistry();
		let targetId = vaultId ?? reg.vaults[0]?.id;
		if (targetId == null) {
			targetId = crypto.randomUUID();
			reg = addVault(reg, { id: targetId, label: "", createdAt: Date.now() });
			await writeRegistry(reg);
		}
		const path = blobFileFor(targetId);
		// Snapshot the previous good bytes before truncating, so a crash mid-write
		// is recoverable via restoreVaultFromBackup.
		if (await fileExists(path)) {
			const cur = await Filesystem.readFile({ path, directory: DIR });
			await Filesystem.writeFile({
				path: backupFileFor(targetId),
				directory: DIR,
				data: cur.data as string,
			});
		}
		await Filesystem.writeFile({ path, directory: DIR, data: bytesToBase64(blob) });
	},
	async restoreVaultFromBackup(vaultId) {
		await ensureMigrated();
		const reg = await readRegistry();
		const targetId = vaultId ?? reg.vaults[0]?.id;
		if (targetId == null) return false;
		const bakPath = backupFileFor(targetId);
		if (!(await fileExists(bakPath))) return false;
		const bak = await Filesystem.readFile({ path: bakPath, directory: DIR });
		await Filesystem.writeFile({
			path: blobFileFor(targetId),
			directory: DIR,
			data: bak.data as string,
		});
		return true;
	},
	/** Delete a vault's blob file and recovery snapshot. Idempotent (missing files are skipped). */
	async deleteVaultBlob(vaultId) {
		await ensureMigrated();
		const path = blobFileFor(vaultId);
		const bak = backupFileFor(vaultId);
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
