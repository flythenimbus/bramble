import { sha256Hex } from "./sigv4";
import type { BackupObject, BackupTarget } from "./types";

export interface BackupResult {
	key: string;
	hash: string;
	uploaded: number; // bytes
	prunedKeys: string[];
}

// Compact, lexically-sortable UTC stamp: 20260710T224759Z. Only URL/path-safe
// characters, so object keys need no escaping when signed or PUT.
function compactStamp(d: Date): string {
	return d.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/** Object key: <prefix>/bramble-<stamp>-<shorthash>.bramble (sorts chronologically). */
export function backupKey(prefix: string, stamp: string, hash: string): string {
	return `${prefix}/bramble-${stamp}-${hash.slice(0, 8)}.bramble`;
}

/**
 * Keep-last-N retention: the keys to delete, computed deterministically from the
 * listing (so concurrent prunes from two devices converge). The compact stamp in
 * each key sorts chronologically, so lexical order is chronological.
 */
export function selectForPruning(objects: BackupObject[], keep: number): string[] {
	const backups = objects.filter((o) => o.key.includes("/bramble-"));
	const newestFirst = [...backups].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
	return newestFirst.slice(keep).map((o) => o.key);
}

/**
 * Upload the vault blob as a new dated snapshot, then prune to keep-last-N. The
 * caller decides whether a backup is due or changed; this just runs one.
 */
export async function runBackup(
	target: BackupTarget,
	blob: Uint8Array,
	opts: { prefix?: string; keep?: number; now?: Date } = {},
): Promise<BackupResult> {
	const prefix = opts.prefix ?? "bramble";
	const keep = opts.keep ?? 30;
	const hash = await sha256Hex(blob);
	const key = backupKey(prefix, compactStamp(opts.now ?? new Date()), hash);
	await target.put(key, blob, "application/octet-stream");

	const prunedKeys = selectForPruning(await target.list(`${prefix}/`), keep);
	for (const k of prunedKeys) {
		// A failed delete is not fatal; the next run retries it (delete is idempotent).
		try {
			await target.remove(k);
		} catch {}
	}
	return { key, hash, uploaded: blob.byteLength, prunedKeys };
}
