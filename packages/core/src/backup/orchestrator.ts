import type { BackupBody } from "./archive";
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
 * Where a snapshot is written before it is moved into place: the same folder, a leading dot, and
 * `.partial`. Both keep it out of `selectForPruning` (which matches `/bramble-`) and out of sight in
 * most file browsers, so a snapshot name only ever appears on a complete file.
 */
export function uploadTempKey(key: string): string {
	const slash = key.lastIndexOf("/");
	return `${key.slice(0, slash + 1)}.${key.slice(slash + 1)}.partial`;
}

/** Whether a snapshot key is this vault's own: what pruning and the incomplete-upload sweep may
 * touch. See `selectForPruning` for how untagged keys count. */
function isOwnSnapshotKey(key: string, vaultId?: string): boolean {
	if (!key.includes("/bramble-")) return false;
	if (!vaultId) return !/-v[0-9a-f]{8}\.bramble$/i.test(key);
	return key.endsWith(`-v${vaultTag(vaultId)}.bramble`);
}

/** How old an upload's temporary file must be before a later run treats it as abandoned. Long
 * enough that another device's upload still in flight to the same folder is never swept from
 * under it. */
export const STALE_UPLOAD_MS = 60 * 60 * 1000;

/**
 * Temporary files left by uploads that never finished (the app was killed between the write and
 * the move), for the next run to delete. Scoped to this vault the same way `selectForPruning` is,
 * and only when the server says how old the file is: an undated one might be in flight.
 */
export function selectStaleUploads(objects: BackupObject[], now: Date, vaultId?: string): string[] {
	const tag = vaultId ? `-v${vaultTag(vaultId)}.bramble.partial` : undefined;
	return objects
		.filter((o) => {
			const name = o.key.slice(o.key.lastIndexOf("/") + 1);
			if (!name.startsWith(".bramble-") || !name.endsWith(".bramble.partial")) return false;
			if (tag ? !name.endsWith(tag) : /-v[0-9a-f]{8}\.bramble\.partial$/i.test(name)) return false;
			const modified = Date.parse(o.lastModified ?? "");
			return Number.isFinite(modified) && now.getTime() - modified > STALE_UPLOAD_MS;
		})
		.map((o) => o.key);
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
	// `keep <= 0` is "keep everything", and the guard is the whole safety of that reading: without
	// it `slice(0)` returns every snapshot and the caller deletes the lot. Nothing could reach 0
	// through the UI before, which is exactly why it was safe to be wrong about.
	if (keep <= 0) return [];
	const backups = objects.filter((o) => isOwnSnapshotKey(o.key, vaultId));
	const newestFirst = [...backups].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
	return newestFirst.slice(keep).map((o) => o.key);
}

/**
 * Upload a backup as a new dated snapshot, then prune to keep-last-N. The caller decides
 * whether a backup is due or changed; this just runs one. `fingerprint` is the plan's (see
 * planBackup), which names the snapshot: hashing the body here would mean reading all of it.
 */
export async function runBackup(
	target: BackupTarget,
	body: BackupBody,
	opts: { fingerprint: string; prefix?: string; keep?: number; now?: Date; vaultId?: string },
): Promise<BackupResult> {
	const prefix = opts.prefix ?? "bramble";
	const keep = opts.keep ?? 30;
	const hash = opts.fingerprint;
	const now = opts.now ?? new Date();
	const key = backupKey(prefix, compactStamp(now), hash, opts.vaultId);
	await target.put(key, body, "application/octet-stream");

	// Pruning is housekeeping, and the snapshot is already safely uploaded by this point. A
	// listing that fails (or deletes that do) must not fail the backup: doing so leaves the
	// target's lastVaultHash unadvanced, so the next run re-uploads the same bytes, and a target
	// whose prune is permanently broken would re-upload a full snapshot every five minutes.
	//
	// That tolerance is what makes an append-only credential work at all, and `keep <= 0` makes it
	// deliberate: nothing is listed and nothing is deleted, so a key with neither permission
	// produces no failed requests rather than swallowed ones. See docs/cloud-storage-backups.md.
	let prunedKeys: string[] = [];
	if (keep <= 0) return { key, hash, uploaded: body.size, prunedKeys };
	try {
		const listing = await target.list(`${prefix}/`);
		prunedKeys = selectForPruning(listing, keep, opts.vaultId);
		// Abandoned upload temporaries ride along with the prune: same listing, same tolerance.
		for (const k of [...prunedKeys, ...selectStaleUploads(listing, now, opts.vaultId)]) {
			// A failed delete is not fatal; the next run retries it (delete is idempotent).
			try {
				await target.remove(k);
			} catch {}
		}
	} catch {
		prunedKeys = [];
	}
	// Uploads in parts that never completed hold storage the user pays for but cannot see. Same
	// tolerance as the prune: housekeeping never fails a backup that already landed.
	try {
		await target.sweepIncomplete?.(`${prefix}/`, now, (k) => isOwnSnapshotKey(k, opts.vaultId));
	} catch {}
	return { key, hash, uploaded: body.size, prunedKeys };
}
