// Vault-level merge: a multi-value register per entry over sealed envelopes. Each version carries
// its causal history (sync/causal.ts), so concurrent versions are kept as siblings instead of one
// being dropped. Only stamps and histories are compared, never decrypted content; because every
// device in a group shares one VEK, a kept envelope from any device decrypts locally. See
// docs/sync-conflicts.md, Phase A.

import type { EncryptedEntry } from "../vault-format";
import {
	containsHistory,
	inHistory,
	isAncestor,
	joinCausal,
	type Versioned,
	writerOf,
} from "./causal";
import type {
	EntriesPayload,
	FileManifest,
	FileRecord,
	SyncedSettings,
	Tombstone,
} from "./entries-payload";
import { compareHlc, type Hlc } from "./hlc";
import { liveRecords, mergeReplicas, type ReplicaState, replicaFrom } from "./merge";

/** What a payload says about one entry beyond its displayed version. */
export interface EntryConflict {
	/** Live versions held that aren't the displayed one. */
	versions: number;
	/** Deleted on another device concurrently with an edit that is still shown. */
	deleted: boolean;
}

/** The file manifest as a replica. Absent lists are empty, never deletions: a client predating
 * the manifest strips the keys and writes the payload back without them, so "the other side said
 * nothing" has to mean exactly that, as it does for settings. */
function filesToReplica(manifest: FileManifest): ReplicaState<FileRecord> {
	return replicaFrom(
		manifest.files ?? [],
		(manifest.fileTombstones ?? []).map((t) => [t.id, t.hlc] as const),
	);
}

/** One mark per file, at the latest stamp of any delete that took it. Marks are only added. */
function mergeCascades(a: readonly Tombstone[], b: readonly Tombstone[]): Tombstone[] {
	const latest = new Map<string, Hlc>();
	for (const t of [...a, ...b]) {
		const cur = latest.get(t.id);
		if (!cur || compareHlc(t.hlc, cur) > 0) latest.set(t.id, t.hlc);
	}
	return [...latest].map(([id, hlc]) => ({ id, hlc }));
}

/**
 * The attachments a vault shows: not detached, and not taken by a delete of their entry. A file
 * whose entry is displayed shows whatever deleted it, so keeping a delete-conflicted entry brings
 * its files back. The single implementation of "live" for files: GC, backups, blob sync and the
 * UI all read it, so the rule is written once.
 */
export function shownFiles(
	manifest: FileManifest,
	shownEntries: ReadonlySet<string>,
): FileRecord[] {
	const taken = new Set((manifest.fileCascades ?? []).map((t) => t.id));
	return liveRecords(filesToReplica(manifest)).filter(
		(f) => f.entryId === undefined || shownEntries.has(f.entryId) || !taken.has(f.id),
	);
}

/** `shownFiles` for a stored payload, whose displayed entries are its `entries`. */
export function liveFiles(payload: EntriesPayload): FileRecord[] {
	return shownFiles(payload, new Set(payload.entries.map((e) => e.id)));
}

/** Same-stamp copies are one version: keep the one that has a history, else the first seen. */
function collapse(versions: readonly EncryptedEntry[]): EncryptedEntry[] {
	const byStamp = new Map<string, EncryptedEntry>();
	for (const v of versions) {
		const key = `${v.hlc.wall}:${v.hlc.counter}:${v.hlc.node}`;
		const cur = byStamp.get(key);
		if (!cur || (!cur.vv && v.vv)) byStamp.set(key, v);
	}
	return [...byStamp.values()];
}

/** One tombstone per id: the union of every delete's history. */
function mergeTombstones(
	x: Tombstone | undefined,
	y: Tombstone | undefined,
): Tombstone | undefined {
	if (!x) return y;
	if (!y) return x;
	// A legacy tombstone at the other's stamp, or already inside it, is a stripped copy of a known
	// delete; its LWW claim would kill every delete-conflicted edit stamped below it. Two with
	// histories always join, even at one stamp: a joined tombstone carries its newest delete's.
	if (compareHlc(x.hlc, y.hlc) === 0 && !(x.vv && y.vv)) return x.vv ? x : y;
	if (!x.vv && inHistory(writerOf(x), x.hlc, y)) return y;
	if (!y.vv && inHistory(writerOf(y), y.hlc, x)) return x;
	const hlc = compareHlc(x.hlc, y.hlc) >= 0 ? x.hlc : y.hlc;
	const { vv, floor } = joinCausal([x, y]);
	if (Object.keys(vv).length === 0 && floor && compareHlc(floor, hlc) === 0)
		return { id: x.id, hlc };
	return floor ? { id: x.id, hlc, vv, floor } : { id: x.id, hlc, vv };
}

/** The highest-stamp version, alone, or none. */
function newest(versions: readonly EncryptedEntry[]): EncryptedEntry[] {
	return [...collapse(versions)].sort((p, q) => compareHlc(q.hlc, p.hlc)).slice(0, 1);
}

/** The surviving live versions of one entry, highest stamp first. */
function survivors(live: readonly EncryptedEntry[], tomb: Tombstone | undefined): EncryptedEntry[] {
	const kept: EncryptedEntry[] = [];
	// Top-down, so a stale copy pruned under a newer version never gets to prune anything itself.
	for (const v of [...collapse(live)].sort((p, q) => compareHlc(q.hlc, p.hlc))) {
		if (tomb && isAncestor(v, tomb)) continue;
		if (kept.some((k) => isAncestor(v, k))) continue;
		kept.push(v);
	}
	return kept;
}

/**
 * Merge two entries payloads into one. Commutative, associative, and idempotent over histories
 * built by the rules in docs/sync-conflicts.md, so pairwise gossip across devices converges.
 * Per entry: the highest-stamp surviving version is displayed (`entries`), the other survivors
 * are kept sealed in `conflicts`, and deletes join into one tombstone kept forever. An entry
 * holding a file that no delete of it marked survives the delete as a delete conflict. Envelopes
 * are carried verbatim.
 */
export function mergeEntriesPayload(a: EntriesPayload, b: EntriesPayload): EntriesPayload {
	const order: string[] = [];
	const live = new Map<string, EncryptedEntry[]>();
	const note = (e: EncryptedEntry) => {
		const list = live.get(e.id);
		if (list) list.push(e);
		else {
			live.set(e.id, [e]);
			order.push(e.id);
		}
	};
	// Ids keep their first-seen order, displayed entries before siblings, as the LWW merge did.
	for (const e of a.entries) note(e);
	for (const e of b.entries) note(e);
	for (const e of a.conflicts ?? []) note(e);
	for (const e of b.conflicts ?? []) note(e);

	const tombs = new Map<string, Tombstone>();
	for (const t of [...a.tombstones, ...b.tombstones]) {
		const merged = mergeTombstones(tombs.get(t.id), t);
		if (merged) tombs.set(t.id, merged);
	}

	// The file manifest stays last-writer-wins per id: greatest HLC wins, a tombstone beats an
	// equal stamp, and a record whose blob this device lacks still merges (the bytes are fetched
	// separately, so the manifest never waits on them). A delete's marks only hide a file, so its
	// record is kept for an entry that comes back.
	const fileState = mergeReplicas(filesToReplica(a), filesToReplica(b));
	const files = liveRecords(fileState);
	const fileTombstones = [...fileState.tombstones].map(([id, hlc]) => ({ id, hlc }));
	const fileCascades = mergeCascades(a.fileCascades ?? [], b.fileCascades ?? []);
	const marked = new Set(fileCascades.map((t) => t.id));
	// Entries holding a file no delete of them marked: attached where the delete hadn't reached.
	const contested = new Set(
		files.flatMap((f) => (f.entryId !== undefined && !marked.has(f.id) ? [f.entryId] : [])),
	);

	const entries: EncryptedEntry[] = [];
	const conflicts: EncryptedEntry[] = [];
	for (const id of order) {
		const versions = live.get(id) ?? [];
		let kept = survivors(versions, tombs.get(id));
		// A delete that didn't see one of the entry's files doesn't take it: the newest version
		// stays shown as a delete conflict, as an edit the delete didn't see would.
		if (kept.length === 0 && contested.has(id)) kept = newest(versions);
		const [shown, ...rest] = kept;
		if (shown) entries.push(shown);
		conflicts.push(...rest);
	}
	const out: EntriesPayload = { entries, tombstones: [...tombs.values()] };
	if (conflicts.length > 0) out.conflicts = conflicts;
	const settings = mergeSyncedSettings(a.settings, b.settings);
	return {
		...out,
		...(settings ? { settings } : {}),
		// Emitted only when non-empty, so a vault that has never held a file keeps the exact
		// payload shape it has today rather than gaining empty arrays on its next write.
		...(files.length > 0 ? { files } : {}),
		...(fileTombstones.length > 0 ? { fileTombstones } : {}),
		...(fileCascades.length > 0 ? { fileCascades } : {}),
	};
}

/** The displayed version, its siblings and its tombstone, for building a write's history. */
export function heldVersions(payload: EntriesPayload, id: string): Versioned[] {
	return [
		...payload.entries.filter((e) => e.id === id),
		...(payload.conflicts ?? []).filter((e) => e.id === id),
		...payload.tombstones.filter((t) => t.id === id),
	];
}

type IdVersion = { readonly id: string } & Versioned;

/** The parts of a payload that say which versions exist, sealed or not. */
export interface VersionIndex {
	readonly entries: readonly IdVersion[];
	readonly conflicts?: readonly IdVersion[];
	readonly tombstones: readonly IdVersion[];
}

/** Every displayed entry that has siblings or a concurrent delete. */
export function entryConflicts(payload: VersionIndex): Map<string, EntryConflict> {
	const siblings = new Map<string, IdVersion[]>();
	for (const e of payload.conflicts ?? []) siblings.set(e.id, [...(siblings.get(e.id) ?? []), e]);
	const tombs = new Map(payload.tombstones.map((t) => [t.id, t]));
	const out = new Map<string, EntryConflict>();
	for (const shown of payload.entries) {
		const others = siblings.get(shown.id) ?? [];
		const tomb = tombs.get(shown.id);
		const deleted = !!tomb && ![shown, ...others].some((e) => containsHistory(e, tomb));
		if (others.length > 0 || deleted) out.set(shown.id, { versions: others.length, deleted });
	}
	return out;
}

/**
 * Merge the vault-scoped settings map: per key, the higher stamp wins.
 *
 * Per KEY rather than per map, so two devices that changed two different settings both keep
 * theirs. And a key present on one side only is kept, never treated as a deletion: a client that
 * predates this map strips it and writes the payload back without it, so "the other side said
 * nothing" has to mean exactly that. Clearing is a `value: null` record with its own stamp.
 * See docs/synced-settings.md.
 */
function mergeSyncedSettings(
	a: SyncedSettings | undefined,
	b: SyncedSettings | undefined,
): SyncedSettings | undefined {
	if (!a) return b;
	if (!b) return a;
	const out: SyncedSettings = { ...a };
	for (const [key, rec] of Object.entries(b)) {
		const cur = out[key];
		if (!cur || compareHlc(rec.hlc, cur.hlc) > 0) out[key] = rec;
	}
	return out;
}
