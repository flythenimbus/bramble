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

/**
 * The vault marker in an object key: `-v<first 8 of the vault id>`, appended after the content
 * hash so the stamp stays the first variable component and lexical order stays chronological.
 *
 * Retention is keep-last-N over a prefix listing, and two vaults are allowed to point at the same
 * folder now that each configures its own target (the folder field defaults blank, so they often
 * do). Without a marker each vault's prune would count the other's snapshots towards N and delete
 * them: a rarely-edited vault loses its only copy to a daily one. The marker is what makes a
 * listing separable, so a prune can only ever delete its own vault's files.
 */
function vaultTag(vaultId: string): string {
	return vaultId.replace(/-/g, "").slice(0, 8);
}

/** Object key: `<prefix>/bramble-<stamp>-<shorthash>[-v<tag>].bramble` (sorts chronologically). */
export function backupKey(prefix: string, stamp: string, hash: string, vaultId?: string): string {
	const tag = vaultId ? `-v${vaultTag(vaultId)}` : "";
	return `${prefix}/bramble-${stamp}-${hash.slice(0, 8)}${tag}.bramble`;
}

/**
 * Keep-last-N retention: the keys to delete, computed deterministically from the
 * listing (so concurrent prunes from two devices converge). The compact stamp in
 * each key sorts chronologically, so lexical order is chronological.
 *
 * `vaultId` scopes it to one vault's own snapshots. Untagged keys (written before the marker
 * existed, or by an older build) count as this vault's ONLY when no vault is given, which is the
 * case for a folder that belongs to a single vault by construction: the legacy device-global
 * layout, where each vault already had its own `<prefix>` or `<prefix>-<id>` folder. Anything
 * tagged for another vault is never returned, whatever else is true.
 */
export function selectForPruning(
	objects: BackupObject[],
	keep: number,
	vaultId?: string,
): string[] {
	const tag = vaultId ? `-v${vaultTag(vaultId)}.bramble` : undefined;
	const backups = objects.filter((o) => {
		if (!o.key.includes("/bramble-")) return false;
		if (!tag) return !/-v[0-9a-f]{8}\.bramble$/i.test(o.key);
		return o.key.endsWith(tag);
	});
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
	opts: { prefix?: string; keep?: number; now?: Date; vaultId?: string } = {},
): Promise<BackupResult> {
	const prefix = opts.prefix ?? "bramble";
	const keep = opts.keep ?? 30;
	const hash = await sha256Hex(blob);
	const key = backupKey(prefix, compactStamp(opts.now ?? new Date()), hash, opts.vaultId);
	await target.put(key, blob, "application/octet-stream");

	// Pruning is housekeeping, and the snapshot is already safely uploaded by this point. A
	// listing that fails (or deletes that do) must not fail the backup: doing so leaves the
	// target's lastVaultHash unadvanced, so the next run re-uploads the same bytes, and a target
	// whose prune is permanently broken would re-upload a full snapshot every five minutes.
	let prunedKeys: string[] = [];
	try {
		prunedKeys = selectForPruning(await target.list(`${prefix}/`), keep, opts.vaultId);
		for (const k of prunedKeys) {
			// A failed delete is not fatal; the next run retries it (delete is idempotent).
			try {
				await target.remove(k);
			} catch {}
		}
	} catch {
		prunedKeys = [];
	}
	return { key, hash, uploaded: blob.byteLength, prunedKeys };
}
