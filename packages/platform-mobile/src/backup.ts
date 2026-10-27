// Opportunistic cloud backups on mobile.
//
// There is no background scheduler on iOS or Android, so a wall-clock promise cannot be kept
// here: the only moments this process is reliably alive and able to decrypt are an unlock and a
// resume, and those are what this listens to. The desktop keeps a real schedule because it is
// tray-resident with credentials in the OS store; mobile has neither, so the setting means "next
// time you open Bramble after this long" rather than "at this time".
//
// Everything below is platform I/O. The due decision and the orchestration are the pure, tested
// runScheduledBackups/isDue in @core, the same ones the extension and the desktop drive.
// See docs/cloud-storage-backups.md.

import { App as CapacitorApp } from "@capacitor/app";
import type { BackupActivityAdapter } from "@core/adapters/backup-activity";
import { createTarget, runBackup, signingTransport } from "@core/backup";
import { planBackup } from "@core/backup/archive";
import {
	type BackupSecrets,
	type BackupTargetConfig,
	backupTargetsKeyFor,
	keyVaultIdFor,
	metaListCache,
	targetPrefixFor,
	toProviderConfig,
} from "@core/backup/config";
import { backupPlanner, runScheduledBackups, type VaultBackup } from "@core/backup/run";
import { onBlobArrived } from "@core/sync/blob-arrivals";
import type { BlobStore } from "@core/vault/blob-store";
import { parseRegistry, VAULT_REGISTRY_KEY } from "@core/vault/vault-registry";
import { mobileCrypto } from "./adapters/crypto";
import { mobileFiles } from "./adapters/files";
import { mobileHttp } from "./adapters/http";
import { mobileStorage } from "./adapters/storage";
import { onVaultStateChange } from "./adapters/vault-session";

/** Mirrors the lock state rather than asking for it: the VEK is what a run actually needs, and
 * only the crypto adapter knows when it appears and disappears. Starts locked, because it is. */
let unlocked = false;
let running = false;

/** Targets this runner is uploading right now, for the settings screen to show. */
const uploading = new Set<string>();
const activityListeners = new Set<(ids: ReadonlySet<string>) => void>();
function setUploading(id: string, on: boolean): void {
	if (on) uploading.add(id);
	else uploading.delete(id);
	const snapshot = new Set(uploading);
	for (const cb of activityListeners) cb(snapshot);
}

export const mobileBackupActivity: BackupActivityAdapter = {
	subscribe(callback) {
		activityListeners.add(callback);
		callback(new Set(uploading));
		return () => activityListeners.delete(callback);
	},
};

/** A vault's attachment store, or null if its id cannot be a folder (then it is backed up alone). */
function vaultBlobs(vaultId: string): BlobStore | null {
	try {
		return mobileFiles.forVault(vaultId).blobs;
	} catch {
		return null;
	}
}

async function loadTargets(vaultId: string): Promise<BackupTargetConfig[]> {
	return (await mobileStorage.getMeta<BackupTargetConfig[]>(backupTargetsKeyFor(vaultId))) ?? [];
}

/**
 * Every registered vault's sealed blob.
 *
 * Reading one needs no VEK, so a locked vault still has bytes; whether its targets can be
 * unwrapped is decided per target below. A vault whose blob will not read is skipped rather than
 * failing the run, since one unreadable vault should not stop the others.
 */
async function listVaults(): Promise<VaultBackup[]> {
	const reg = parseRegistry(await mobileStorage.getMeta(VAULT_REGISTRY_KEY));
	const out: VaultBackup[] = [];
	for (const v of reg.vaults) {
		try {
			out.push({
				id: v.id,
				blob: await mobileStorage.readVaultBlob(v.id),
				isDefault: v.id === reg.vaults[0]?.id,
			});
		} catch {}
	}
	return out;
}

/**
 * Run any due and changed backup, if the vault is open. No-op otherwise.
 *
 * Exported for the Settings screen's own trigger and for tests; the listeners below are the
 * ordinary path.
 */
export async function runDueBackups(): Promise<void> {
	if (running || !unlocked) return;
	running = true;
	// One plan per vault per run. The plan reads no attachment: an unchanged vault is skipped on its
	// fingerprint alone, and the archive is laid out (once, whatever the number of targets) only
	// when something uploads it.
	const planner = backupPlanner((vault) =>
		planBackup({
			vault: vault.blob,
			blobs: vaultBlobs(vault.id),
			// The one global key: it opens only the unlocked vault's payload, which is also the only
			// vault whose targets can run here. Any other vault's list is the one cached at its last
			// unlock, or the vault waits.
			decryptWithVek: (iv, ct) => mobileCrypto.decryptWithVek(iv, ct),
			listCache: metaListCache(mobileStorage, vault.id),
		}),
	);
	try {
		const result = await runScheduledBackups(
			{
				// Auto-lock fires when the app is backgrounded, so a lock mid-run is the normal case
				// here. The rule: start nothing new once locked, but finish and record what is
				// already in hand. Only starting a run and unwrapping a credential are gated.
				//
				// The target list is read and written regardless, and the two must move together:
				// the runner re-reads it after uploading and saves a merged copy, so a gated read
				// with an ungated save would write an empty list and delete every target.
				listVaults: async () => (unlocked ? listVaults() : []),
				loadTargets: loadTargets,
				saveTargets: (vaultId, targets) =>
					mobileStorage.setMeta(backupTargetsKeyFor(vaultId), targets),
				hashVault: planner.fingerprint,
				blocked: planner.blocked,
				decryptSecrets: async (_vaultId, creds) => {
					// No VEK once locked, and no new work either: this target stays due and goes next
					// time, rather than failing.
					if (!unlocked) return null;
					try {
						return JSON.parse(
							await mobileCrypto.decryptWithVek(creds.iv, creds.ciphertext),
						) as BackupSecrets;
					} catch {
						// Null is a skip, not a failure: this is what a target wrapped under another
						// vault's key looks like, and nothing is wrong with the run.
						return null;
					}
				},
				upload: async (_vaultId, t, secrets, vault) => {
					// Not gated: the credential was unwrapped before the lock, and stopping now would
					// throw away an upload the user is waiting on. Never null here: OS-held
					// credentials are a desktop thing, so every target on this platform is VEK-wrapped.
					if (secrets === null) throw new Error("no credentials for this target");
					const cfg = toProviderConfig(t, secrets);
					// Signed here with the secret just unwrapped, sent over the native transport:
					// no S3 endpoint or WebDAV server grants CORS to the WebView's origin, so a
					// plain fetch would fail before reaching the network. See @core/adapters/http.
					const target = createTarget(cfg, signingTransport(cfg, mobileHttp));
					const body = await planner.body(vault);
					setUploading(t.id, true);
					try {
						await runBackup(target, body, {
							fingerprint: await planner.fingerprint(vault),
							prefix: targetPrefixFor(t, vault.id, vault.isDefault),
							keep: t.keep,
							vaultId: keyVaultIdFor(t, vault.id),
						});
					} finally {
						setUploading(t.id, false);
					}
				},
			},
			Date.now(),
		);
		if (result.attempted > 0) {
			console.info(
				`[bramble] backup: ${result.succeeded.length} ok, ${result.failed.length} failed`,
			);
		}
		for (const f of result.failed) {
			console.warn(`[bramble] backup failed for ${f.id} (vault ${f.vaultId}):`, f.error);
		}
	} finally {
		running = false;
	}
}

/**
 * Listen for the two moments a backup can happen. Returns an unsubscribe; call once.
 *
 * Resume matters as much as unlock: someone who leaves Bramble open for days would otherwise
 * never pass a trigger, and the app is commonly resumed while already unlocked (autofill, a
 * quick copy). The run re-checks the lock state itself, so a resume that races auto-lock is a
 * no-op rather than a decrypt against a vanished key.
 */
export function startBackupRuns(): () => void {
	const offState = onVaultStateChange((locked) => {
		unlocked = !locked;
		if (!locked) void runDueBackups();
	});
	const resume = CapacitorApp.addListener("resume", () => void runDueBackups());
	// A file a waiting backup needed may just have arrived; the run is a no-op if not.
	const offArrival = onBlobArrived(() => void runDueBackups());
	return () => {
		offState();
		offArrival();
		void resume.then((h) => h.remove());
	};
}
