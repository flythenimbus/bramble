// Convergent merge over HLC-stamped records. See docs/p2p-sync.md.
// This is the transport-free kernel of vault sync: it merges two replica
// states into one, deterministically and order-independently, so pairwise
// gossip across N devices converges to the same result. It works on any record
// carrying an `id` and an `hlc`; phase 1 wires the real EncryptedEntry into it.

import { compareHlc, type Hlc } from "./hlc";

/** Anything mergeable: a stable id plus an HLC stamp. */
export interface Stamped {
	readonly id: string;
	readonly hlc: Hlc;
}

/**
 * A replica's mergeable state: the latest record per id, and a graveyard of
 * deletion stamps per id. An id is *live* iff it has a record whose stamp beats
 * any tombstone for that id (see liveRecords). Tombstones are retained, not
 * garbage-collected, which keeps the merge trivially convergent; GC is a later
 * optimization.
 */
export interface ReplicaState<T extends Stamped> {
	readonly records: ReadonlyMap<string, T>;
	readonly tombstones: ReadonlyMap<string, Hlc>;
}

/** An empty replica. */
export function emptyReplica<T extends Stamped>(): ReplicaState<T> {
	return { records: new Map(), tombstones: new Map() };
}

/** Build a replica from a list of records (and optional tombstones), keeping the max stamp per id. */
export function replicaFrom<T extends Stamped>(
	records: Iterable<T>,
	tombstones: Iterable<readonly [string, Hlc]> = [],
): ReplicaState<T> {
	const recs = new Map<string, T>();
	for (const rec of records) {
		const cur = recs.get(rec.id);
		if (!cur || compareHlc(rec.hlc, cur.hlc) > 0) recs.set(rec.id, rec);
	}
	const tombs = new Map<string, Hlc>();
	for (const [id, hlc] of tombstones) {
		const cur = tombs.get(id);
		if (!cur || compareHlc(hlc, cur) > 0) tombs.set(id, hlc);
	}
	return { records: recs, tombstones: tombs };
}

/** Apply a local upsert: the record must already carry a freshly stamped hlc. Returns a new state. */
export function putRecord<T extends Stamped>(state: ReplicaState<T>, record: T): ReplicaState<T> {
	const cur = state.records.get(record.id);
	if (cur && compareHlc(record.hlc, cur.hlc) <= 0) return state;
	const records = new Map(state.records);
	records.set(record.id, record);
	return { records, tombstones: state.tombstones };
}

/** Apply a local delete: `hlc` must be a freshly stamped deletion stamp. Returns a new state. */
export function deleteRecord<T extends Stamped>(
	state: ReplicaState<T>,
	id: string,
	hlc: Hlc,
): ReplicaState<T> {
	const cur = state.tombstones.get(id);
	if (cur && compareHlc(hlc, cur) <= 0) return state;
	const tombstones = new Map(state.tombstones);
	tombstones.set(id, hlc);
	return { records: state.records, tombstones };
}

/**
 * Merge two replica states into one. Commutative, associative, and idempotent
 * over the live set: pairwise gossip in any order converges. Deletion wins ties
 * against a record with an equal stamp (which only arises from distinct events).
 */
export function mergeReplicas<T extends Stamped>(
	a: ReplicaState<T>,
	b: ReplicaState<T>,
): ReplicaState<T> {
	const records = new Map<string, T>();
	for (const src of [a.records, b.records]) {
		for (const [id, rec] of src) {
			const cur = records.get(id);
			if (!cur || compareHlc(rec.hlc, cur.hlc) > 0) records.set(id, rec);
		}
	}
	const tombstones = new Map<string, Hlc>();
	for (const src of [a.tombstones, b.tombstones]) {
		for (const [id, hlc] of src) {
			const cur = tombstones.get(id);
			if (!cur || compareHlc(hlc, cur) > 0) tombstones.set(id, hlc);
		}
	}
	return { records, tombstones };
}

/** The live records: those not dominated by a tombstone (deletion wins ties). */
export function liveRecords<T extends Stamped>(state: ReplicaState<T>): T[] {
	const out: T[] = [];
	for (const [id, rec] of state.records) {
		const t = state.tombstones.get(id);
		if (!t || compareHlc(rec.hlc, t) > 0) out.push(rec);
	}
	return out;
}
