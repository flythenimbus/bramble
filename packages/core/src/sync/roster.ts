// The sync group's device roster: a convergent CRDT of member devices, reusing
// the same merge kernel as entries. Each device carries the public key used for
// roster-anchored channel auth (phase 3b). Revocation is a tombstone, so a
// removed device stays removed across a merge; re-enrolling a device (a strictly
// newer stamp) brings it back. The roster syncs with the vault so every device
// knows the membership. See docs/p2p-sync.md.

import { z } from "zod";
import { type Tombstone, TombstoneSchema } from "./entries-payload";
import { type Hlc, HlcSchema } from "./hlc";
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
});
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

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
