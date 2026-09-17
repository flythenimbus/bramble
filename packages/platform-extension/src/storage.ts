/// <reference types="chrome" />

import type { StorageAdapter } from "@core/adapters/storage";
import { PER_VAULT_SYNC_KEYS, syncKeyFor } from "@core/sync/sync-keys";
import { base64ToBytes, bytesToBase64 } from "@core/util/bytes";
import {
	addVault,
	EMPTY_REGISTRY,
	parseRegistry,
	VAULT_REGISTRY_KEY,
	type VaultRecord,
	type VaultRegistry,
} from "@core/vault/vault-registry";
import { api } from "./platform-api";
import { clearLegacyHandle, getLegacyHandle } from "./storage-legacy";

export const VAULT_BLOB_KEY = "vault-blob-b64";
/** Recovery snapshot of the previous vault bytes, written before every overwrite so a crash mid-write leaves a recoverable copy. */
const VAULT_BLOB_BACKUP_KEY = "vault-blob-backup-b64";

// Every vault is addressed by id: its blob lives at `<base>:<id>` and its snapshot at `<backup>:<id>`.
// (A pre-namespacing vault's blob sat at the un-suffixed `<base>`; the one-time migration copies it
// to `<base>:<id>`. See runMigration.)
function blobKeyFor(id: string): string {
	return `${VAULT_BLOB_KEY}:${id}`;
}
function backupKeyFor(id: string): string {
	return `${VAULT_BLOB_BACKUP_KEY}:${id}`;
}

/** True for any vault's blob storage key: a namespaced `<base>:<id>` key, or the un-suffixed `<base>`
 * a pre-namespacing vault briefly occupies mid-migration. Excludes the backup key. Used by the sync
 * blob-change watcher, which only knows the changed key name, to detect an edit to a vault. */
export function isVaultBlobKey(key: string): boolean {
	return key === VAULT_BLOB_KEY || key.startsWith(`${VAULT_BLOB_KEY}:`);
}

// --- Legacy File System Access migration ---
// Pre-migration vaults lived in a real file (an FSA handle in IndexedDB), which required a
// user gesture to (re)grant permission on every service-worker restart - hostile UX under
// MV3 (the SW dies every ~30s and the permission lapses). The vault now lives in
// chrome.storage.local: the extension's own sandbox, which needs no gesture, survives SW
// restarts, and is readable/writable headless. An existing file-backed vault is materialised
// into local storage on the first unlock (a real click, so the one-time file read is
// permitted); the original file is left on disk as the user's own backup. The IndexedDB
// handle glue lives in ./storage-legacy; this whole path can be deleted once no file-backed
// installs remain.

/**
 * Copy a file-backed vault into local storage at its namespaced key. MUST run inside a user gesture
 * (the file read may prompt for permission). Writes local storage first, then drops the handle, so a
 * crash mid-copy just re-copies next time. The file itself is never modified or deleted - it stays as
 * the user's backup.
 */
async function migrateLegacyVault(handle: FileSystemFileHandle, id: string): Promise<Uint8Array> {
	if ((await handle.queryPermission({ mode: "read" })) !== "granted") {
		if ((await handle.requestPermission({ mode: "read" })) !== "granted") {
			throw new Error("permission denied for vault file");
		}
	}
	const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
	await api.storage.local.set({ [blobKeyFor(id)]: bytesToBase64(bytes) });
	await clearLegacyHandle();
	return bytes;
}

/** Read the base64 blob stored at `key`, or null when absent/empty. */
async function blobAt(key: string): Promise<Uint8Array | null> {
	const r = await api.storage.local.get(key);
	const b64 = r[key];
	return typeof b64 === "string" && b64.length > 0 ? base64ToBytes(b64) : null;
}

async function readRegistry(): Promise<VaultRegistry> {
	const r = await api.storage.local.get(VAULT_REGISTRY_KEY);
	return parseRegistry(r[VAULT_REGISTRY_KEY]);
}
async function writeRegistry(reg: VaultRegistry): Promise<void> {
	await api.storage.local.set({ [VAULT_REGISTRY_KEY]: reg });
}

// One-time migration to the uniform per-vault namespace. A pre-namespacing vault's blob + sync
// identity sat at the un-suffixed keys; this COPIES them to `<key>:<id>` (never a move - the flat
// data stays authoritative until the copy is done and the registry cut over), then deletes the flat
// keys. Crash-safe (copy -> registry cutover -> delete: an interrupt before the cutover just re-runs;
// after it, the flat keys are harmless orphans) and concurrency-safe (copyFlatVaultToNamespaced only
// writes flat values that still exist, so a racing context can't clobber a namespaced key with null;
// and every no-registry cutover write re-checks for a registry a racing context published first and
// adopts it, so two UI documents migrating at once converge on one vault id).
// Memoised so it runs once per context. See docs/multiple-vaults.md.
let migration: Promise<void> | null = null;
function ensureMigrated(): Promise<void> {
	if (!migration) migration = runMigration();
	return migration;
}
async function runMigration(): Promise<void> {
	await migrateNamespacing();
	await reapGhostRecords();
}

// A record with neither a blob, a recovery snapshot, nor a sync group is an orphan from a
// create/join that registered the vault but never wrote it. The picker still offers it, selecting
// it dead-ends on the first-run screen, and it can't be deleted from the UI, so reap it. Startup
// only: a vault being created is briefly in exactly this state. Skipped entirely while a legacy
// FSA handle exists, because that vault's record legitimately has no blob until the first unlock
// materialises it (see readVaultBlob).
async function reapGhostRecords(): Promise<void> {
	const reg = await readRegistry();
	if (reg.vaults.length === 0) return;
	const live: VaultRecord[] = [];
	for (const v of reg.vaults) {
		const keys = await api.storage.local.get([
			blobKeyFor(v.id),
			backupKeyFor(v.id),
			syncKeyFor("sync.group", v.id),
		]);
		if (Object.values(keys).some((x) => x != null)) live.push(v);
	}
	if (live.length === reg.vaults.length) return;
	// Only consult the handle once something would actually be dropped, so the common startup
	// never touches IndexedDB.
	if ((await getLegacyHandle()) !== null) return;
	await writeRegistry({ vaults: live });
}

async function migrateNamespacing(): Promise<void> {
	const raw = (await api.storage.local.get(VAULT_REGISTRY_KEY))[VAULT_REGISTRY_KEY] as
		| { legacyBlobVaultId?: unknown }
		| undefined;

	if (raw != null) {
		// A registry exists. The only thing left to do is finish namespacing a vault it still points
		// at the flat keys via the retired `legacyBlobVaultId` (raw-read; parseRegistry strips it).
		const flatId = typeof raw.legacyBlobVaultId === "string" ? raw.legacyBlobVaultId : null;
		if (flatId == null) return; // already uniform
		await copyFlatVaultToNamespaced(flatId);
		await writeRegistry(parseRegistry(raw)); // cutover: registry without legacyBlobVaultId
		await deleteFlatVaultKeys();
		return;
	}

	// No registry: a pre-multi-vault single vault (a local blob, or an even-older FSA handle), or a
	// fresh install.
	const hasLocal = (await blobAt(VAULT_BLOB_KEY)) !== null;
	const hasFsa = !hasLocal && (await getLegacyHandle()) !== null;
	if (!hasLocal && !hasFsa) {
		// Empty flat state is ambiguous: fresh install, OR a racing context (two UI documents opened
		// together) migrated and deleted the flat keys since our registry read. The racer publishes
		// its registry before deleting, so re-check and adopt it; writing EMPTY here would clobber
		// it and strand the migrated vault ("create a vault" over real data).
		if (!(await registryExists())) await writeRegistry(EMPTY_REGISTRY);
		return;
	}
	const id = crypto.randomUUID();
	await copyFlatVaultToNamespaced(id); // FSA vaults have no flat blob; they materialise namespaced on unlock
	if (await registryExists()) {
		// A racing context won the cutover under its own id; drop this context's unpublished copies.
		await api.storage.local.remove([
			blobKeyFor(id),
			backupKeyFor(id),
			...PER_VAULT_SYNC_KEYS.map((k) => syncKeyFor(k, id)),
		]);
		return;
	}
	await writeRegistry(addVault(EMPTY_REGISTRY, { id, label: "", createdAt: Date.now() }));
	await deleteFlatVaultKeys();
}

/** True when a registry has been published (possibly by a racing context, mid-migration). */
async function registryExists(): Promise<boolean> {
	return (await api.storage.local.get(VAULT_REGISTRY_KEY))[VAULT_REGISTRY_KEY] != null;
}

/** Copy a pre-namespacing vault's flat storage (blob, recovery snapshot, and the per-vault sync keys)
 * to its `:<id>` keys. Reads the flat values first and only writes those that exist, so it never
 * clobbers a namespaced key with null when a racing context already migrated + deleted the flat data.
 * Preserves values byte-for-byte, so the copied sync identity keeps the device paired. */
async function copyFlatVaultToNamespaced(id: string): Promise<void> {
	const flat = await api.storage.local.get([
		VAULT_BLOB_KEY,
		VAULT_BLOB_BACKUP_KEY,
		...PER_VAULT_SYNC_KEYS,
	]);
	const writes: Record<string, unknown> = {};
	if (flat[VAULT_BLOB_KEY] !== undefined) writes[blobKeyFor(id)] = flat[VAULT_BLOB_KEY];
	if (flat[VAULT_BLOB_BACKUP_KEY] !== undefined)
		writes[backupKeyFor(id)] = flat[VAULT_BLOB_BACKUP_KEY];
	for (const k of PER_VAULT_SYNC_KEYS) {
		if (flat[k] !== undefined) writes[syncKeyFor(k, id)] = flat[k];
	}
	if (Object.keys(writes).length > 0) await api.storage.local.set(writes);
}

/** Delete the flat (un-suffixed) blob, snapshot, and sync keys after the cutover. Best-effort:
 * any left behind are unread orphans. */
async function deleteFlatVaultKeys(): Promise<void> {
	await api.storage.local.remove([VAULT_BLOB_KEY, VAULT_BLOB_BACKUP_KEY, ...PER_VAULT_SYNC_KEYS]);
}

/** Snapshot the current bytes at `key` into `backupKey` before an overwrite; clear the backup when there is nothing to snapshot, so we can't later restore over a freshly created vault. */
async function snapshotBlob(key: string, backupKey: string): Promise<void> {
	try {
		// Copy the raw base64 string without decoding: blobAt() would inflate it
		// into bytes (whole vault) only for us to re-encode it here, holding the
		// string + bytes + re-encoded string at once on every write.
		const r = await api.storage.local.get(key);
		const b64 = r[key];
		if (typeof b64 !== "string" || b64.length === 0) {
			await api.storage.local.remove(backupKey);
			return;
		}
		await api.storage.local.set({ [backupKey]: b64 });
	} catch {
		// Best-effort: failing the write because the backup failed would block all saves.
	}
}

export const extensionStorage: StorageAdapter = {
	/** True when a vault exists: a registered vault, or (defensively) a legacy file. */
	async hasVaultHandle(vaultId) {
		await ensureMigrated();
		const reg = await readRegistry();
		if (vaultId != null) {
			if ((await blobAt(blobKeyFor(vaultId))) !== null) return true;
			// The first vault may still be an un-materialised FSA file.
			if (vaultId === reg.vaults[0]?.id) return (await getLegacyHandle()) !== null;
			return false;
		}
		if (reg.vaults.length > 0) return true;
		return (await getLegacyHandle()) !== null;
	},

	/** Read the vault bytes, materialising a legacy file-backed vault on first read (inside the unlock gesture). Throws when no vault is stored. */
	async readVaultBlob(vaultId) {
		await ensureMigrated();
		const reg = await readRegistry();
		const targetId = vaultId ?? reg.vaults[0]?.id;
		if (targetId == null) throw new Error("no vault stored");
		const bytes = await blobAt(blobKeyFor(targetId));
		if (bytes !== null) return bytes;
		// The first vault may still be an un-materialised FSA file; write it to its namespaced key now.
		if (targetId === reg.vaults[0]?.id) {
			const handle = await getLegacyHandle();
			if (handle) return migrateLegacyVault(handle, targetId);
		}
		throw new Error("no vault stored");
	},

	/** Write the vault bytes, snapshotting a recoverable backup first. */
	async writeVaultBlob(blob, vaultId) {
		await ensureMigrated();
		const reg = await readRegistry();
		const targetId = vaultId ?? reg.vaults[0]?.id;
		// Never mint a registry record here: a blind write with an empty registry means the caller
		// lost its vault id, and registering one strands a vault the UI can't open or delete.
		if (targetId == null) throw new Error("writeVaultBlob: no vault id, and no vault registered");
		const key = blobKeyFor(targetId);
		await snapshotBlob(key, backupKeyFor(targetId));
		await api.storage.local.set({ [key]: bytesToBase64(blob) });
	},

	/** Restore the last pre-write backup over the live vault. Returns false when no backup exists. */
	async restoreVaultFromBackup(vaultId) {
		await ensureMigrated();
		const reg = await readRegistry();
		const targetId = vaultId ?? reg.vaults[0]?.id;
		if (targetId == null) return false;
		const backupKey = backupKeyFor(targetId);
		const r = await api.storage.local.get(backupKey);
		const b64 = r[backupKey];
		if (typeof b64 !== "string" || b64.length === 0) return false;
		await api.storage.local.set({ [blobKeyFor(targetId)]: b64 });
		return true;
	},

	/** Delete a vault's blob and recovery snapshot. Idempotent (removing an absent key is a no-op). */
	async deleteVaultBlob(vaultId) {
		await ensureMigrated();
		await api.storage.local.remove(blobKeyFor(vaultId));
		await api.storage.local.remove(backupKeyFor(vaultId));
	},

	// Meta reads/writes gate on the migration too: the registry lives here, so a read that skipped
	// it could hand the UI a pre-reap registry. (runMigration uses api.storage.local directly, so
	// this can't recurse.)
	/** Read a plaintext metadata value from chrome.storage.local. */
	async getMeta(key) {
		await ensureMigrated();
		const result = await api.storage.local.get(key);
		return result[key];
	},

	/** Write a plaintext metadata value to chrome.storage.local. */
	async setMeta(key, value) {
		await ensureMigrated();
		await api.storage.local.set({ [key]: value });
	},

	/** Delete a metadata key from chrome.storage.local. */
	async removeMeta(key) {
		await api.storage.local.remove(key);
	},

	// Fire when this key changes in storage.local, including writes from the background
	// (e.g. a scheduled backup updating backup.targets), so an open popup/options page can
	// live-refresh instead of showing stale status until reopened.
	subscribeMeta(key, callback) {
		const handler = (changes: { [name: string]: chrome.storage.StorageChange }, area: string) => {
			if (area === "local" && key in changes) callback();
		};
		api.storage.onChanged.addListener(handler);
		return () => api.storage.onChanged.removeListener(handler);
	},
};
