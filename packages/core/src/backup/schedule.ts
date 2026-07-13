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

interface Schedulable {
	frequency: BackupFrequency;
	lastBackupAt?: number;
	lastVaultHash?: string;
}

/** True when the frequency has elapsed since the last backup (never backed up = due). */
export function isDue(t: Schedulable, now: number): boolean {
	if (t.frequency === "off") return false;
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
