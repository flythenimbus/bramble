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
	type WrappedCreds,
} from "@core/backup/config";
import { runScheduledBackups } from "@core/backup/run";
import { api } from "../platform-api";
import { extensionStorage } from "../storage";
import { sendToOffscreen } from "./offscreen-client";
import { vaultLocked } from "./session";

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

// Unwrap a target's VEK-wrapped credentials via the offscreen crypto host. The
// cached VEK is auto-reinjected there if the offscreen was killed.
async function decryptSecrets(creds: WrappedCreds): Promise<BackupSecrets> {
	const dec = await sendToOffscreen({
		type: "CRYPTO_DECRYPT_OUTER",
		payload: { iv: creds.iv, ciphertext: creds.ciphertext },
	});
	if (!dec.ok || typeof dec.data !== "string") throw new Error("Couldn't unlock credentials.");
	return JSON.parse(dec.data) as BackupSecrets;
}

let running = false;

/** Run any due+changed backup headlessly while unlocked. No-op if locked or nothing due. */
export async function runDueBackups(): Promise<void> {
	if (running || vaultLocked()) return;
	running = true;
	try {
		const result = await runScheduledBackups(
			{
				loadTargets: async () =>
					(await extensionStorage.getMeta<BackupTargetConfig[]>(BACKUP_TARGETS_KEY)) ?? [],
				saveTargets: (targets) => extensionStorage.setMeta(BACKUP_TARGETS_KEY, targets),
				readBlob: () => extensionStorage.readVaultBlob(),
				hashBlob: (blob) => sha256Hex(blob),
				decryptSecrets,
				upload: async (t, secrets, blob) => {
					const target = createTarget(toProviderConfig(t, secrets));
					await runBackup(target, blob, { prefix: backupPrefix(t), keep: t.keep });
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
