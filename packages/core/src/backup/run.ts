import type { BackupBlocked, BackupBody, BackupPlan } from "./archive";
import {
	applyBackupOutcomes,
	type BackupOutcome,
	type BackupSecrets,
	type BackupTargetConfig,
	credsAreOsHeld,
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
	/** Every local vault's sealed blob. Reading one needs no VEK, so a locked vault still has
	 * bytes to upload; whether it can is decided by decryptSecrets. */
	listVaults(): Promise<VaultBackup[]>;
	loadTargets(vaultId: string): Promise<BackupTargetConfig[]>;
	saveTargets(vaultId: string, targets: BackupTargetConfig[]): Promise<void>;
	/** One vault's fingerprint, so an unchanged vault skips re-upload. */
	hashVault(vault: VaultBackup): Promise<string>;
	/** Why this vault cannot be backed up whole right now, if it cannot. Its due targets are then
	 * marked waiting and nothing is uploaded: a partial backup is never made in its place. */
	blocked?(vault: VaultBackup): Promise<BackupBlocked | undefined>;
	/** Unwrap a target's credentials, or null when no resident VEK opens them (that vault is
	 * locked). Null is a skip, not a failure: nothing is wrong, the run just can't happen yet.
	 * Not called at all for a target whose credentials the OS holds (desktop). */
	decryptSecrets(vaultId: string, creds: WrappedCreds): Promise<BackupSecrets | null>;
	/** Upload one vault's backup to one of its targets. `secrets` is null when the platform holds
	 * them outside the vault, in which case its transport authenticates instead. */
	upload(
		vaultId: string,
		target: BackupTargetConfig,
		secrets: BackupSecrets | null,
		vault: VaultBackup,
	): Promise<void>;
}

export interface ScheduledBackupResult {
	attempted: number;
	succeeded: { vaultId: string; id: string }[];
	failed: { vaultId: string; id: string; error: string }[];
	/** Targets left for later because their vault is locked (see decryptSecrets). */
	skipped: number;
	/** Due targets not backed up because their vault could not be backed up whole. */
	waiting: number;
}

/**
 * One plan per vault per run, so the fingerprint, the wait and the upload all describe the same
 * file, and the archive is laid out at most once however many targets upload it.
 */
export function backupPlanner(planFor: (vault: VaultBackup) => Promise<BackupPlan>) {
	const plans = new Map<string, Promise<BackupPlan>>();
	const bodies = new Map<string, Promise<BackupBody>>();
	const plan = (vault: VaultBackup): Promise<BackupPlan> => {
		let pending = plans.get(vault.id);
		if (!pending) {
			pending = planFor(vault);
			plans.set(vault.id, pending);
		}
		return pending;
	};
	return {
		plan,
		/** The runner's `hashVault`. */
		fingerprint: async (vault: VaultBackup) => (await plan(vault)).fingerprint,
		/** The runner's `blocked`. */
		blocked: async (vault: VaultBackup) => (await plan(vault)).blocked,
		body: (vault: VaultBackup): Promise<BackupBody> => {
			let pending = bodies.get(vault.id);
			if (!pending) {
				pending = plan(vault).then((p) => p.body());
				bodies.set(vault.id, pending);
			}
			return pending;
		},
	};
}

/**
 * Back up every vault whose own targets are due and whose blob changed since their last run.
 * Targets belong to one vault (`backup.targets:<vaultId>`), so each vault is evaluated on its
 * own: its own change fingerprint, its own schedule state, its own credentials. A failed target
 * keeps its old lastBackupAt (stays due, retries next trigger); a success advances it and clears
 * any error; a locked vault's targets are left untouched. See docs/cloud-storage-backups.md.
 */
export async function runScheduledBackups(
	deps: ScheduledBackupDeps,
	now: number,
): Promise<ScheduledBackupResult> {
	const result: ScheduledBackupResult = {
		attempted: 0,
		succeeded: [],
		failed: [],
		skipped: 0,
		waiting: 0,
	};
	const vaults = await deps.listVaults();

	for (const vault of vaults) {
		const targets = await deps.loadTargets(vault.id);
		if (!targets.some((t) => isDue(t, now))) continue;

		const blocked = await deps.blocked?.(vault);
		if (blocked) {
			const due = targets.filter((t) => isDue(t, now));
			const latest = await deps.loadTargets(vault.id);
			await deps.saveTargets(
				vault.id,
				applyBackupOutcomes(latest, new Map(due.map((t) => [t.id, { blocked }])), now),
			);
			result.waiting += due.length;
			continue;
		}

		const hash = await deps.hashVault(vault);
		const toRun = selectDueTargets(targets, now, hash);
		if (toRun.length === 0) {
			// Every due target already holds this vault. One that was waiting no longer is.
			if (targets.some((t) => t.waiting)) {
				const latest = await deps.loadTargets(vault.id);
				await deps.saveTargets(
					vault.id,
					latest.map((t) => (t.waiting ? { ...t, waiting: undefined } : t)),
				);
			}
			continue;
		}

		const outcome = new Map<string, BackupOutcome>();
		// Sequential: callers back a shared crypto host whose key injection can't race.
		for (const t of toRun) {
			try {
				// OS-held credentials (desktop) need no vault key, which is what lets a locked
				// vault still meet its schedule there; everywhere else the VEK has to open them.
				let secrets: BackupSecrets | null = null;
				if (!credsAreOsHeld(t.creds)) {
					secrets = await deps.decryptSecrets(vault.id, t.creds);
					if (secrets === null) {
						result.skipped += 1;
						continue;
					}
				}
				await deps.upload(vault.id, t, secrets, vault);
				outcome.set(t.id, { hash });
			} catch (e) {
				outcome.set(t.id, { error: (e as Error).message, hash });
			}
		}
		if (outcome.size === 0) continue;

		// Re-read the list (it may have changed during the uploads) and fold results in by id.
		const latest = await deps.loadTargets(vault.id);
		await deps.saveTargets(vault.id, applyBackupOutcomes(latest, outcome, now));

		for (const [id, r] of outcome) {
			result.attempted += 1;
			if (r.error !== undefined) result.failed.push({ vaultId: vault.id, id, error: r.error });
			else result.succeeded.push({ vaultId: vault.id, id });
		}
	}

	return result;
}
