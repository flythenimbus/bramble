// Vault-level merge: applies the phase-0 convergent merge to the real entries
// payload. Operates only on sealed envelopes (EncryptedEntry) and tombstones,
// never on decrypted secrets, per docs/p2p-sync.md. Because all devices in a
// group share one VEK, a winning envelope from any device decrypts locally, so
// the merge just selects sealed blobs by stamp.

import type { EncryptedEntry } from "../vault-format";
import type { EntriesPayload, SyncedSettings } from "./entries-payload";
import { compareHlc } from "./hlc";
import { liveRecords, mergeReplicas, type ReplicaState, replicaFrom } from "./merge";

/** View a stored payload as a mergeable replica (max stamp per id for both maps). */
function payloadToReplica(payload: EntriesPayload): ReplicaState<EncryptedEntry> {
	return replicaFrom(
		payload.entries,
		payload.tombstones.map((t) => [t.id, t.hlc] as const),
	);
}

/** Render a replica back to a storable payload: live entries plus the graveyard. */
function replicaToPayload(state: ReplicaState<EncryptedEntry>): EntriesPayload {
	return {
		entries: liveRecords(state),
		tombstones: [...state.tombstones].map(([id, hlc]) => ({ id, hlc })),
	};
}

/**
 * Merge two entries payloads into one. Commutative, associative, and idempotent,
 * so pairwise gossip across devices converges. Same-id entries resolve by HLC;
 * the winner's sealed envelope is carried verbatim. Deletions win against older
 * entries; an edit stamped after a delete resurrects.
 *
 * Invariant: two envelopes that share an id and an exact stamp must have
 * identical content (they came from the same write), since the stamp is unique
 * per write per device.
 */
export function mergeEntriesPayload(a: EntriesPayload, b: EntriesPayload): EntriesPayload {
	const merged = replicaToPayload(mergeReplicas(payloadToReplica(a), payloadToReplica(b)));
	const settings = mergeSyncedSettings(a.settings, b.settings);
	return settings ? { ...merged, settings } : merged;
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
