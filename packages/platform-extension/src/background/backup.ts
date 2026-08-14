/// <reference types="chrome" />

// Scheduled cloud backups, run headlessly in the background service worker while
// the vault session is unlocked. This file only wires the platform I/O; the
// orchestration + due decision are the pure, tested runScheduledBackups/isDue in
// @core. Crypto is driven by messaging the offscreen host (sendToOffscreen),
// mirroring how sync works headlessly. See docs/cloud-storage-backups.md.

import { createTarget, runBackup, sha256Hex } from "@core/backup";
import {
	type BackupSecrets,
	type BackupTargetConfig,
	backupTargetsKeyFor,
	keyVaultIdFor,
	migrateBackupTargetsToVaults,
	targetPrefixFor,
	toProviderConfig,
	type WrappedCreds,
} from "@core/backup/config";
import { runScheduledBackups, type VaultBackup } from "@core/backup/run";
import { parseRegistry, VAULT_REGISTRY_KEY } from "@core/vault/vault-registry";
import { api } from "../platform-api";
import { extensionStorage } from "../storage";
import { sendToOffscreen } from "./offscreen-client";
import { unlockedVaultIds, vaultLocked } from "./session";

export const BACKUP_ALARM = "backup:scheduled";
// A cheap poke; the handler no-ops unless a target is due + changed + unlocked.
const CHECK_PERIOD_MINUTES = 30;

/** Every registered vault, default (first) flag included. */
async function registeredVaults(): Promise<{ id: string; isDefault: boolean }[]> {
	const reg = parseRegistry(await extensionStorage.getMeta(VAULT_REGISTRY_KEY));
	return reg.vaults.map((v) => ({ id: v.id, isDefault: v.id === reg.vaults[0]?.id }));
}

/** One vault's targets. Each vault owns its own list (`backup.targets:<id>`). */
async function loadTargets(vaultId: string): Promise<BackupTargetConfig[]> {
	return (await extensionStorage.getMeta<BackupTargetConfig[]>(backupTargetsKeyFor(vaultId))) ?? [];
}

// Hand a pre-per-vault device-global target list to every vault. Done here as well as in the UI
// hook: the background must not wait for someone to open the Backups panel before an existing
// install's scheduled backups resume. Idempotent, and a no-op once the global keys are gone.
async function ensureMigrated(vaults: { id: string }[]): Promise<void> {
	await migrateBackupTargetsToVaults(
		extensionStorage,
		vaults.map((v) => v.id),
		() => crypto.randomUUID(),
	);
}

/** Arm the recurring poke while any vault has a scheduled target; clear it otherwise. */
export async function scheduleBackups(): Promise<void> {
	const vaults = await registeredVaults();
	await ensureMigrated(vaults);
	let scheduled = false;
	for (const v of vaults) {
		if ((await loadTargets(v.id)).some((t) => t.frequency !== "off")) {
			scheduled = true;
			break;
		}
	}
	if (scheduled) {
		api.alarms.create(BACKUP_ALARM, { periodInMinutes: CHECK_PERIOD_MINUTES });
	} else {
		void api.alarms.clear(BACKUP_ALARM);
	}
}

// Unwrap a target's VEK-wrapped credentials via the offscreen crypto host. A target belongs to one
// vault, so its own vek comes first; targets carried over from the old device-global list were
// wrapped under whichever vault happened to be active back then, so fall back to the other
// unlocked veks (bounded) rather than dropping those backups. Null means no resident vek opened
// them — that vault is locked, which is a skip, not a failure. The durable fix (wrap under a
// device key, not a vault VEK) is deferred; see docs/multiple-vaults.md "Backup cred decrypt".
async function decryptSecrets(vaultId: string, creds: WrappedCreds): Promise<BackupSecrets | null> {
	const unlocked = unlockedVaultIds();
	const candidates = [
		...(unlocked.includes(vaultId) ? [vaultId] : []),
		...unlocked.filter((id) => id !== vaultId),
	];
	for (const id of candidates) {
		const dec = await sendToOffscreen({
			type: "CRYPTO_DECRYPT_OUTER",
			vaultId: id,
			payload: { iv: creds.iv, ciphertext: creds.ciphertext },
		});
		if (dec.ok && typeof dec.data === "string") return JSON.parse(dec.data) as BackupSecrets;
	}
	return null;
}

let running = false;

/** Every registered vault's sealed blob. Backups copy the encrypted blob (no VEK needed), so a
 * locked vault still has bytes to upload; whether its target credentials can be unwrapped is
 * decided per target. A registered vault with no readable blob is skipped. */
async function listVaults(): Promise<VaultBackup[]> {
	const vaults = await registeredVaults();
	await ensureMigrated(vaults);
	const out: VaultBackup[] = [];
	for (const v of vaults) {
		try {
			out.push({
				id: v.id,
				blob: await extensionStorage.readVaultBlob(v.id),
				isDefault: v.isDefault,
			});
		} catch {}
	}
	return out;
}

/** Run any due+changed backup headlessly while unlocked. No-op if locked or nothing due. */
export async function runDueBackups(
	sessionCurrent: () => boolean = () => !vaultLocked(),
): Promise<void> {
	if (running || !sessionCurrent()) return;
	running = true;
	try {
		const result = await runScheduledBackups(
			{
				listVaults: async () => (sessionCurrent() ? listVaults() : []),
				loadTargets: async (vaultId) => (sessionCurrent() ? loadTargets(vaultId) : []),
				saveTargets: async (vaultId, targets) => {
					if (sessionCurrent()) {
						await extensionStorage.setMeta(backupTargetsKeyFor(vaultId), targets);
					}
				},
				// One vault's own fingerprint, so editing one vault no longer re-uploads the others.
				hashVault: async (vault) => (sessionCurrent() ? sha256Hex(vault.blob) : ""),
				decryptSecrets: async (vaultId, creds) => {
					if (!sessionCurrent()) throw new Error("vault session changed");
					return decryptSecrets(vaultId, creds);
				},
				upload: async (_vaultId, t, secrets, vault) => {
					if (!sessionCurrent()) throw new Error("vault session changed");
					// Null means the platform holds the credentials outside the vault, which only
					// the desktop does; every target here is VEK-wrapped, so this cannot be null.
					if (secrets === null) throw new Error("no credentials for this target");
					const target = createTarget(toProviderConfig(t, secrets));
					await runBackup(target, vault.blob, {
						prefix: targetPrefixFor(t, vault.id, vault.isDefault),
						keep: t.keep,
						vaultId: keyVaultIdFor(t, vault.id),
					});
				},
			},
			Date.now(),
		);
		if (result.attempted > 0) {
			console.info(
				`[titanpass:bg] backup: ${result.succeeded.length} ok, ${result.failed.length} failed`,
			);
		}
		for (const f of result.failed) {
			console.warn(`[titanpass:bg] backup failed for ${f.id} (vault ${f.vaultId}):`, f.error);
		}
	} finally {
		running = false;
	}
}
