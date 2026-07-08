// The sync group's device roster: a convergent CRDT of member devices, reusing
// the same merge kernel as entries. Each device carries the public key used for
// roster-anchored channel auth (phase 3b). Revocation is a tombstone, so a
// removed device stays removed across a merge; re-enrolling a device (a strictly
// newer stamp) brings it back. The roster syncs with the vault so every device
// knows the membership. See docs/p2p-sync.md.

import { z } from "zod";
import { type Tombstone, TombstoneSchema } from "./entries-payload";
import { type Hlc, HlcSchema, isFutureStamp } from "./hlc";
import { liveRecords, mergeReplicas, type ReplicaState, replicaFrom } from "./merge";

/** One member device. `id` is the device's node id (the same id used in HLC stamps). */
export const RosterEntrySchema = z.object({
	id: z.string().min(1),
	/** Public key for roster-anchored channel auth, base64. */
	publicKey: z.string().min(1),
	/** User-facing device name. */
	label: z.string(),
	/** Wall-clock enrollment time, for display only. */
	addedAt: z.number().int().nonnegative(),
	hlc: HlcSchema,
	/** Ed25519 verify key that signs this entry (base64). Optional through the phase-1 rollout
	 * (Item A): absent on legacy/unsigned entries. See docs/p2p-sync-revocation-hardening.md. */
	sigKey: z.string().min(1).optional(),
	/** Ed25519 signature over `canonicalRosterEntry` (base64). Optional through phase-1. */
	sig: z.string().min(1).optional(),
});
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

/** The stable string signed for a roster entry: binds `id` <-> `publicKey` <-> `sigKey` <-> stamp,
 * so a member cannot rewrite another device's entry or backdate one. Excludes the mutable display
 * `label` and the `sig` itself. TS and core-rust MUST produce byte-identical output; the pinned test
 * vector is the cross-language contract. Fixed-order array avoids object-key-order ambiguity. */
export function canonicalRosterEntry(entry: RosterEntry): string {
	return JSON.stringify([
		entry.id,
		entry.publicKey,
		entry.sigKey ?? "",
		entry.addedAt,
		entry.hlc.wall,
		entry.hlc.counter,
		entry.hlc.node,
	]);
}

/** The stored/wire roster: active devices plus the revocation graveyard. */
export const RosterPayloadSchema = z.object({
	devices: z.array(RosterEntrySchema),
	revoked: z.array(TombstoneSchema),
});
export type RosterPayload = z.infer<typeof RosterPayloadSchema>;

export function emptyRoster(): RosterPayload {
	return { devices: [], revoked: [] };
}

export function encodeRoster(roster: RosterPayload): string {
	return JSON.stringify(RosterPayloadSchema.parse(roster));
}

export function decodeRoster(json: string): RosterPayload {
	return RosterPayloadSchema.parse(JSON.parse(json));
}

function toReplica(roster: RosterPayload): ReplicaState<RosterEntry> {
	return replicaFrom(
		roster.devices,
		roster.revoked.map((t) => [t.id, t.hlc] as const),
	);
}

function toPayload(state: ReplicaState<RosterEntry>): RosterPayload {
	return {
		devices: liveRecords(state),
		revoked: [...state.tombstones].map(([id, hlc]) => ({ id, hlc })),
	};
}

/** Merge two rosters. Same convergence guarantees as the entries merge. */
export function mergeRosters(a: RosterPayload, b: RosterPayload): RosterPayload {
	return toPayload(mergeReplicas(toReplica(a), toReplica(b)));
}

/** Drop device entries and tombstones stamped implausibly far in the future before merging a
 * REMOTELY-received roster. Without this a malicious member could gossip its own entry stamped
 * years ahead, so a later revocation tombstone (stamped ~now) could never win the merge and the
 * device would be permanently un-revocable. Honest rosters carry near-present stamps. */
export function sanitizeRemoteRoster(
	roster: RosterPayload,
	now: number = Date.now(),
): RosterPayload {
	return {
		devices: roster.devices.filter((d) => !isFutureStamp(d.hlc, now)),
		revoked: roster.revoked.filter((t) => !isFutureStamp(t.hlc, now)),
	};
}

/** Merge a peer's roster into the local one, dropping future-dated (poisoned) stamps first.
 * Hosts MUST use this for a remotely-received roster instead of mergeRosters directly. */
export function mergeRemoteRoster(
	local: RosterPayload,
	remote: RosterPayload,
	now: number = Date.now(),
): RosterPayload {
	return mergeRosters(local, sanitizeRemoteRoster(remote, now));
}

/** Enroll (or re-enroll) a device. The entry must carry a freshly stamped hlc. */
export function addDevice(roster: RosterPayload, device: RosterEntry): RosterPayload {
	return mergeRosters(roster, { devices: [device], revoked: [] });
}

/** Revoke a device. `hlc` must be a freshly stamped revocation stamp. */
export function revokeDevice(roster: RosterPayload, id: string, hlc: Hlc): RosterPayload {
	return mergeRosters(roster, { devices: [], revoked: [{ id, hlc }] });
}

/** The currently active member devices (not revoked). */
export function activeDevices(roster: RosterPayload): RosterEntry[] {
	return liveRecords(toReplica(roster));
}

/** True iff `id` is an active member (used to gate roster-auth handshakes). */
export function isActiveDevice(roster: RosterPayload, id: string): boolean {
	return activeDevices(roster).some((d) => d.id === id);
}

/** The active device with this id, or undefined. */
export function findDevice(roster: RosterPayload, id: string): RosterEntry | undefined {
	return activeDevices(roster).find((d) => d.id === id);
}

export type { Tombstone };
