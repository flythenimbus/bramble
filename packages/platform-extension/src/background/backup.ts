/// <reference types="chrome" />

// Scheduled cloud backups, run headlessly in the background service worker while
// the vault session is unlocked. The background owns storage (extensionStorage)
// and drives crypto by messaging the offscreen host (sendToOffscreen), mirroring
// how sync decrypts/re-encrypts headlessly. The due decision is the pure, tested
// selectDueTargets/isDue from @core. See docs/cloud-storage-backups.md.

import { createTarget, runBackup, sha256Hex } from "@core/backup";
import {
	BACKUP_TARGETS_KEY,
	type BackupSecrets,
	type BackupTargetConfig,
	backupPrefix,
	toProviderConfig,
} from "@core/backup/config";
import { isDue, selectDueTargets } from "@core/backup/schedule";
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

let running = false;

/**
 * Back up every target that is due and whose vault changed since its last run.
 * Reads the targets + vault blob from storage, unwraps each target's credentials
 * via the offscreen crypto host, and uploads. No-op while locked or if nothing is due.
 */
export async function runDueBackups(): Promise<void> {
	if (running || vaultLocked()) return;
	const targets = await extensionStorage.getMeta<BackupTargetConfig[]>(BACKUP_TARGETS_KEY);
	if (!targets?.length) return;
	const now = Date.now();
	if (!targets.some((t) => isDue(t, now))) return;

	running = true;
	try {
		const blob = await extensionStorage.readVaultBlob();
		const hash = await sha256Hex(blob);
		const toRun = selectDueTargets(targets, now, hash);
		if (toRun.length === 0) return; // every due target already holds this vault

		console.info(`[titanpass:bg] backup: running ${toRun.length} target(s)`);
		const results = new Map<string, { hash?: string; error?: string }>();
		// Sequential: the offscreen VEK re-injection isn't safe to race across parallel ops.
		for (const t of toRun) {
			try {
				const dec = await sendToOffscreen({
					type: "CRYPTO_DECRYPT_OUTER",
					payload: { iv: t.creds.iv, ciphertext: t.creds.ciphertext },
				});
				if (!dec.ok || typeof dec.data !== "string") {
					throw new Error("Couldn't unlock credentials.");
				}
				const secrets = JSON.parse(dec.data) as BackupSecrets;
				const target = createTarget(toProviderConfig(t, secrets));
				await runBackup(target, blob, { prefix: backupPrefix(t), keep: t.keep });
				results.set(t.id, { hash });
			} catch (e) {
				console.warn(`[titanpass:bg] backup failed for ${t.providerId}:`, (e as Error).message);
				results.set(t.id, { error: (e as Error).message });
			}
		}

		// Re-read the latest list (the popup may have edited it) and fold results in by id.
		const latest = (await extensionStorage.getMeta<BackupTargetConfig[]>(BACKUP_TARGETS_KEY)) ?? [];
		const doneAt = Date.now();
		await extensionStorage.setMeta(
			BACKUP_TARGETS_KEY,
			latest.map((t) => {
				const r = results.get(t.id);
				if (!r) return t;
				return r.error !== undefined
					? { ...t, lastError: r.error }
					: { ...t, lastBackupAt: doneAt, lastVaultHash: r.hash, lastError: undefined };
			}),
		);
		console.info("[titanpass:bg] backup: done");
	} finally {
		running = false;
	}
}
