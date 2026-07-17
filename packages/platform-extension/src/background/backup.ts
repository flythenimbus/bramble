/// <reference types="chrome" />

// Scheduled cloud backups, run headlessly in the background service worker while
// the vault session is unlocked. This file only wires the platform I/O; the
// orchestration + due decision are the pure, tested runScheduledBackups/isDue in
// @core. Crypto is driven by messaging the offscreen host (sendToOffscreen),
// mirroring how sync works headlessly. See docs/cloud-storage-backups.md.

import { createTarget, runBackup, sha256Hex } from "@core/backup";
import {
	BACKUP_TARGETS_KEY,
	type BackupSecrets,
	type BackupTargetConfig,
	backupPrefix,
	toProviderConfig,
	vaultBackupPrefix,
	type WrappedCreds,
} from "@core/backup/config";
import { runScheduledBackups, type VaultBackup } from "@core/backup/run";
import { parseRegistry, VAULT_REGISTRY_KEY } from "@core/vault/vault-registry";
import { api } from "../platform-api";
import { extensionStorage } from "../storage";
import { sendToOffscreen } from "./offscreen-client";
import { getActiveVaultId, unlockedVaultIds, vaultLocked } from "./session";

export const BACKUP_ALARM = "backup:scheduled";
// A cheap poke; the handler no-ops unless a target is due + changed + unlocked.
const CHECK_PERIOD_MINUTES = 30;

/** Arm the recurring poke while any target is scheduled; clear it otherwise. */
export async function scheduleBackups(): Promise<void> {
	const targets = await extensionStorage.getMeta<BackupTargetConfig[]>(BACKUP_TARGETS_KEY);
	if (targets?.some((t) => t.frequency !== "off")) {
		api.alarms.create(BACKUP_ALARM, { periodInMinutes: CHECK_PERIOD_MINUTES });
	} else {
		void api.alarms.clear(BACKUP_ALARM);
	}
}

// Unwrap a target's VEK-wrapped credentials via the offscreen crypto host. Backup targets are
// device-global but their creds were VEK-wrapped under whichever vault was active when the target
// was created; with several veks now resident, try the active vault first, then each other
// unlocked vault (bounded). The durable fix (wrap under a device key, not a vault VEK) is deferred;
// see docs/multiple-vaults.md "Backup cred decrypt".
async function decryptSecrets(creds: WrappedCreds): Promise<BackupSecrets> {
	const active = getActiveVaultId();
	const candidates = [active, ...unlockedVaultIds().filter((id) => id !== active)].filter(
		(id): id is string => id !== null,
	);
	for (const vaultId of candidates) {
		const dec = await sendToOffscreen({
			type: "CRYPTO_DECRYPT_OUTER",
			vaultId,
			payload: { iv: creds.iv, ciphertext: creds.ciphertext },
		});
		if (dec.ok && typeof dec.data === "string") return JSON.parse(dec.data) as BackupSecrets;
	}
	throw new Error("Couldn't unlock credentials.");
}

let running = false;

/** Run any due+changed backup headlessly while unlocked. No-op if locked or nothing due. */
/** Every registered vault's sealed blob. Backups copy the encrypted blob (no VEK needed), so a
 * locked non-active vault is still backed up. A registered vault with no readable blob is skipped. */
async function readVaults(): Promise<VaultBackup[]> {
	const reg = parseRegistry(await extensionStorage.getMeta(VAULT_REGISTRY_KEY));
	const out: VaultBackup[] = [];
	for (const v of reg.vaults) {
		try {
			out.push({
				id: v.id,
				blob: await extensionStorage.readVaultBlob(v.id),
				isDefault: v.id === reg.vaults[0]?.id,
			});
		} catch {}
	}
	return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

/** One fingerprint over all vaults; id-tagged + sorted so add/remove/edit any vault changes it. */
async function hashVaults(vaults: VaultBackup[]): Promise<string> {
	const enc = new TextEncoder();
	const parts = [...vaults]
		.sort((a, b) => a.id.localeCompare(b.id))
		.flatMap((v) => [enc.encode(`${v.id}:`), v.blob]);
	return sha256Hex(concatBytes(parts));
}

export async function runDueBackups(): Promise<void> {
	if (running || vaultLocked()) return;
	running = true;
	try {
		const result = await runScheduledBackups(
			{
				loadTargets: async () =>
					(await extensionStorage.getMeta<BackupTargetConfig[]>(BACKUP_TARGETS_KEY)) ?? [],
				saveTargets: (targets) => extensionStorage.setMeta(BACKUP_TARGETS_KEY, targets),
				readVaults,
				hashVaults,
				decryptSecrets,
				upload: async (t, secrets, vaults) => {
					const target = createTarget(toProviderConfig(t, secrets));
					// Sequential per vault: the offscreen crypto host is shared and can't race.
					for (const v of vaults) {
						const prefix = vaultBackupPrefix(backupPrefix(t), v.id, v.isDefault);
						await runBackup(target, v.blob, { prefix, keep: t.keep });
					}
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
			console.warn(`[titanpass:bg] backup failed for ${f.id}:`, f.error);
		}
	} finally {
		running = false;
	}
}
