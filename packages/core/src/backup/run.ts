import type { BackupSecrets, BackupTargetConfig, WrappedCreds } from "./config";
import { isDue, selectDueTargets } from "./schedule";

/**
 * The I/O a scheduled run needs, injected so the orchestration is testable without
 * a browser, storage, crypto host, or network. The extension wires real ones; tests
 * pass fakes.
 */
export interface ScheduledBackupDeps {
	loadTargets(): Promise<BackupTargetConfig[]>;
	saveTargets(targets: BackupTargetConfig[]): Promise<void>;
	readBlob(): Promise<Uint8Array>;
	hashBlob(blob: Uint8Array): Promise<string>;
	decryptSecrets(creds: WrappedCreds): Promise<BackupSecrets>;
	upload(target: BackupTargetConfig, secrets: BackupSecrets, blob: Uint8Array): Promise<void>;
}

export interface ScheduledBackupResult {
	attempted: number;
	succeeded: string[]; // target ids
	failed: { id: string; error: string }[];
}

const EMPTY: ScheduledBackupResult = { attempted: 0, succeeded: [], failed: [] };

/**
 * Back up every target that is due and whose vault changed since its last run.
 * Reads the vault once, unwraps + uploads each target sequentially, then folds the
 * per-target success/failure back into the stored list. A failed target keeps its
 * old lastBackupAt (stays due, retries next trigger); a success advances it and
 * clears any error. See docs/cloud-storage-backups.md.
 */
export async function runScheduledBackups(
	deps: ScheduledBackupDeps,
	now: number,
): Promise<ScheduledBackupResult> {
	const targets = await deps.loadTargets();
	if (!targets.some((t) => isDue(t, now))) return EMPTY;

	const blob = await deps.readBlob();
	const hash = await deps.hashBlob(blob);
	const toRun = selectDueTargets(targets, now, hash);
	if (toRun.length === 0) return EMPTY; // every due target already holds this vault

	const outcome = new Map<string, { hash?: string; error?: string }>();
	// Sequential: callers back a shared crypto host whose key injection can't race.
	for (const t of toRun) {
		try {
			const secrets = await deps.decryptSecrets(t.creds);
			await deps.upload(t, secrets, blob);
			outcome.set(t.id, { hash });
		} catch (e) {
			outcome.set(t.id, { error: (e as Error).message });
		}
	}

	// Re-read the list (it may have changed during the uploads) and fold results in by id.
	const latest = await deps.loadTargets();
	await deps.saveTargets(
		latest.map((t) => {
			const r = outcome.get(t.id);
			if (!r) return t;
			return r.error !== undefined
				? { ...t, lastError: r.error }
				: { ...t, lastBackupAt: now, lastVaultHash: r.hash, lastError: undefined };
		}),
	);

	const succeeded: string[] = [];
	const failed: { id: string; error: string }[] = [];
	for (const [id, r] of outcome) {
		if (r.error !== undefined) failed.push({ id, error: r.error });
		else succeeded.push(id);
	}
	return { attempted: outcome.size, succeeded, failed };
}
