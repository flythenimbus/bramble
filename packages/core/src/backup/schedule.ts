import type { BackupFrequency } from "./config";

const DAY = 24 * 60 * 60 * 1000;

/** Milliseconds between backups for a frequency; Infinity for "off". */
export function intervalMs(frequency: BackupFrequency): number {
	switch (frequency) {
		case "daily":
			return DAY;
		case "weekly":
			return 7 * DAY;
		case "monthly":
			return 30 * DAY;
		default:
			return Number.POSITIVE_INFINITY;
	}
}

/** Doubling starts here. Long enough that a wrong password is not hammered, short enough that a
 * laptop that was simply offline catches up within one nap. */
const RETRY_BASE_MS = 15 * 60 * 1000;

interface Schedulable {
	frequency: BackupFrequency;
	lastBackupAt?: number;
	lastVaultHash?: string;
	failures?: number;
	failedAt?: number;
}

/**
 * How long a target waits after `failures` consecutive failures before it is due again.
 *
 * A failure does not advance `lastBackupAt`, so without this a failing target is due at every
 * trigger forever: on the desktop's five-minute tick that is twelve authentication attempts an
 * hour, unattended, for as long as the credential stays wrong. Providers notice. Nextcloud's
 * brute-force protection throttles the account after enough failures from one address, so the
 * retry loop manufactures a lockout that outlives the correction.
 *
 * Doubling from fifteen minutes, capped at the target's own interval, so a backoff can never
 * stretch a daily backup into a weekly one however long it has been failing. The cap is what
 * bounds it: the doubling reaches the cap and stays there. (`2 ** n` overflowing to Infinity for
 * an absurd `failures` is harmless, since the cap is then what `Math.min` returns.)
 */
export function retryDelayMs(failures: number, frequency: BackupFrequency): number {
	if (failures <= 0) return 0;
	return Math.min(RETRY_BASE_MS * 2 ** (failures - 1), intervalMs(frequency));
}

/** True when the frequency has elapsed since the last backup (never backed up = due), and the
 * target is not waiting out a retry backoff. */
export function isDue(t: Schedulable, now: number): boolean {
	if (t.frequency === "off") return false;
	if (t.failedAt != null) {
		const since = now - t.failedAt;
		// A negative `since` means the clock moved backwards; treating that as "no backoff" costs
		// one early attempt, where trusting it would park the target until the clock caught up.
		if (since >= 0 && since < retryDelayMs(t.failures ?? 1, t.frequency)) return false;
	}
	return t.lastBackupAt == null || now - t.lastBackupAt >= intervalMs(t.frequency);
}

/**
 * The targets to back up now: due by their frequency AND whose last backup didn't
 * already capture the current vault (identical hash means nothing changed, so skip).
 */
export function selectDueTargets<T extends Schedulable>(
	targets: T[],
	now: number,
	currentVaultHash: string,
): T[] {
	return targets.filter((t) => isDue(t, now) && t.lastVaultHash !== currentVaultHash);
}
