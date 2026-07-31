import {
	applyBackupOutcomes,
	type BackupSecrets,
	type BackupTargetConfig,
	type WrappedCreds,
} from "./config";
import { isDue, selectDueTargets } from "./schedule";

/**
 * The I/O a scheduled run needs, injected so the orchestration is testable without
 * a browser, storage, crypto host, or network. The extension wires real ones; tests
 * pass fakes.
 */
/** One vault to back up: its id, its sealed blob, and whether it's the default (first) vault
 * whose snapshots stay at the un-suffixed prefix so existing backups keep going. */
export interface VaultBackup {
	id: string;
	blob: Uint8Array;
	isDefault: boolean;
}

export interface ScheduledBackupDeps {
	loadTargets(): Promise<BackupTargetConfig[]>;
	saveTargets(targets: BackupTargetConfig[]): Promise<void>;
	/** Every local vault's sealed blob. Backups copy the encrypted blob (no VEK), so all vaults
	 * can be backed up regardless of which one is unlocked. */
	readVaults(): Promise<VaultBackup[]>;
	/** A single fingerprint over all vaults, so an unchanged set skips re-upload. */
	hashVaults(vaults: VaultBackup[]): Promise<string>;
	decryptSecrets(creds: WrappedCreds): Promise<BackupSecrets>;
	/** Upload every vault to `target` (each to its own per-vault key namespace). */
	upload(target: BackupTargetConfig, secrets: BackupSecrets, vaults: VaultBackup[]): Promise<void>;
}

export interface ScheduledBackupResult {
	attempted: number;
	succeeded: string[]; // target ids
	failed: { id: string; error: string }[];
}

const EMPTY: ScheduledBackupResult = { attempted: 0, succeeded: [], failed: [] };

/**
 * Back up every target that is due and whose vaults changed since its last run.
 * Reads all vaults once, unwraps + uploads each target sequentially, then folds the
 * per-target success/failure back into the stored list. A failed target keeps its
 * old lastBackupAt (stays due, retries next trigger); a success advances it and
 * clears any error. The change fingerprint covers every vault, so a due target
 * re-uploads all of them whenever any one changes. See docs/cloud-storage-backups.md.
 */
export async function runScheduledBackups(
	deps: ScheduledBackupDeps,
	now: number,
): Promise<ScheduledBackupResult> {
	const targets = await deps.loadTargets();
	if (!targets.some((t) => isDue(t, now))) return EMPTY;

	const vaults = await deps.readVaults();
	const hash = await deps.hashVaults(vaults);
	const toRun = selectDueTargets(targets, now, hash);
	if (toRun.length === 0) return EMPTY; // every due target already holds these vaults

	const outcome = new Map<string, { hash?: string; error?: string }>();
	// Sequential: callers back a shared crypto host whose key injection can't race.
	for (const t of toRun) {
		try {
			const secrets = await deps.decryptSecrets(t.creds);
			await deps.upload(t, secrets, vaults);
			outcome.set(t.id, { hash });
		} catch (e) {
			outcome.set(t.id, { error: (e as Error).message });
		}
	}

	// Re-read the list (it may have changed during the uploads) and fold results in by id.
	const latest = await deps.loadTargets();
	await deps.saveTargets(applyBackupOutcomes(latest, outcome, now));

	const succeeded: string[] = [];
	const failed: { id: string; error: string }[] = [];
	for (const [id, r] of outcome) {
		if (r.error !== undefined) failed.push({ id, error: r.error });
		else succeeded.push(id);
	}
	return { attempted: outcome.size, succeeded, failed };
}
