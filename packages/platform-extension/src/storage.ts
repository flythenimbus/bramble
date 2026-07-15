/// <reference types="chrome" />

import type { StorageAdapter } from "@core/adapters/storage";
import { base64ToBytes, bytesToBase64 } from "@core/util/bytes";
import {
	addVault,
	EMPTY_REGISTRY,
	parseRegistry,
	VAULT_REGISTRY_KEY,
	type VaultRegistry,
} from "@core/vault/vault-registry";
import { api } from "./platform-api";
import { clearLegacyHandle, getLegacyHandle } from "./storage-legacy";

export const VAULT_BLOB_KEY = "vault-blob-b64";
/** Recovery snapshot of the previous vault bytes, written before every overwrite so a crash mid-write leaves a recoverable copy. */
const VAULT_BLOB_BACKUP_KEY = "vault-blob-backup-b64";

// A vault's blob lives at a per-vault key `<base>:<id>`, except the first vault
// (the "legacy blob" vault), which stays at the un-suffixed `<base>` so the
// single-vault -> multi-vault migration moves no bytes. See docs/multiple-vaults.md.
function blobKeyFor(id: string, reg: VaultRegistry): string {
	return id === reg.legacyBlobVaultId ? VAULT_BLOB_KEY : `${VAULT_BLOB_KEY}:${id}`;
}
function backupKeyFor(id: string, reg: VaultRegistry): string {
	return id === reg.legacyBlobVaultId ? VAULT_BLOB_BACKUP_KEY : `${VAULT_BLOB_BACKUP_KEY}:${id}`;
}

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
 * deleted - it stays as the user's backup. Writes the legacy blob key, which is where the
 * first (legacy-slot) vault lives.
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

// Single-vault -> multi-vault migration: register the existing vault (if any) so every
// vault is addressable by id. It moves no bytes - the existing vault keeps the legacy blob
// key (blobKeyFor honours legacyBlobVaultId) - so it is invisible to every current caller.
// Idempotent (a present registry means done) and memoised so it runs once per context.
let migration: Promise<void> | null = null;
function ensureMigrated(): Promise<void> {
	if (!migration) migration = runMigration();
	return migration;
}
async function runMigration(): Promise<void> {
	const existing = await api.storage.local.get(VAULT_REGISTRY_KEY);
	if (existing[VAULT_REGISTRY_KEY] != null) return;
	// A pre-migration single vault shows up as a local blob, or a not-yet-migrated legacy
	// FSA handle (checked only when there is no local blob, to avoid an IndexedDB read on
	// the common path).
	const hasLocal = (await blobAt(VAULT_BLOB_KEY)) !== null;
	const hasFsa = !hasLocal && (await getLegacyHandle()) !== null;
	const reg =
		hasLocal || hasFsa
			? addVault(EMPTY_REGISTRY, { id: crypto.randomUUID(), label: "", createdAt: Date.now() })
			: EMPTY_REGISTRY;
	await writeRegistry(reg);
}

/** Snapshot the current bytes at `key` into `backupKey` before an overwrite; clear the backup when there is nothing to snapshot, so we can't later restore over a freshly created vault. */
async function snapshotBlob(key: string, backupKey: string): Promise<void> {
	try {
		const existing = await blobAt(key);
		if (existing === null) {
			await api.storage.local.remove(backupKey);
			return;
		}
		await api.storage.local.set({ [backupKey]: bytesToBase64(existing) });
	} catch {
		// Best-effort: failing the write because the backup failed would block all saves.
	}
}

export const extensionStorage: StorageAdapter = {
	/** True when a vault exists: a registered vault, or (defensively) a raw local blob / legacy file. */
	async hasVaultHandle(vaultId) {
		await ensureMigrated();
		const reg = await readRegistry();
		if (vaultId != null) {
			if ((await blobAt(blobKeyFor(vaultId, reg))) !== null) return true;
			if (vaultId === reg.legacyBlobVaultId) return (await getLegacyHandle()) !== null;
			return false;
		}
		if (reg.vaults.length > 0) return true;
		if ((await blobAt(VAULT_BLOB_KEY)) !== null) return true;
		return (await getLegacyHandle()) !== null;
	},

	/** Read the vault bytes, migrating a legacy file-backed vault on first read (inside the unlock gesture). Throws when no vault is stored. */
	async readVaultBlob(vaultId) {
		await ensureMigrated();
		const reg = await readRegistry();
		const targetId = vaultId ?? reg.primaryId;
		if (targetId == null) throw new Error("no vault stored");
		const bytes = await blobAt(blobKeyFor(targetId, reg));
		if (bytes !== null) return bytes;
		// The legacy-slot vault may still be an un-migrated FSA file; materialise it now.
		if (targetId === reg.legacyBlobVaultId) {
			const handle = await getLegacyHandle();
			if (handle) return migrateLegacyVault(handle);
		}
		throw new Error("no vault stored");
	},

	/** Write the vault bytes, snapshotting a recoverable backup first. With no id and no primary yet (fresh install), bootstraps the first vault. */
	async writeVaultBlob(blob, vaultId) {
		await ensureMigrated();
		let reg = await readRegistry();
		let targetId = vaultId ?? reg.primaryId;
		if (targetId == null) {
			targetId = crypto.randomUUID();
			reg = addVault(reg, { id: targetId, label: "", createdAt: Date.now() });
			await writeRegistry(reg);
		}
		const key = blobKeyFor(targetId, reg);
		await snapshotBlob(key, backupKeyFor(targetId, reg));
		await api.storage.local.set({ [key]: bytesToBase64(blob) });
	},

	/** Restore the last pre-write backup over the live vault. Returns false when no backup exists. */
	async restoreVaultFromBackup(vaultId) {
		await ensureMigrated();
		const reg = await readRegistry();
		const targetId = vaultId ?? reg.primaryId;
		if (targetId == null) return false;
		const backupKey = backupKeyFor(targetId, reg);
		const r = await api.storage.local.get(backupKey);
		const b64 = r[backupKey];
		if (typeof b64 !== "string" || b64.length === 0) return false;
		await api.storage.local.set({ [blobKeyFor(targetId, reg)]: b64 });
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
