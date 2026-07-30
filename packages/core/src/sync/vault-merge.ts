// Vault-level merge: applies the phase-0 convergent merge to the real entries
// payload. Operates only on sealed envelopes (EncryptedEntry) and tombstones,
// never on decrypted secrets, per docs/p2p-sync.md. Because all devices in a
// group share one VEK, a winning envelope from any device decrypts locally, so
// the merge just selects sealed blobs by stamp.

import type { EncryptedEntry } from "../vault-format";
import type { EntriesPayload } from "./entries-payload";
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
	return replicaToPayload(mergeReplicas(payloadToReplica(a), payloadToReplica(b)));
}
