// The structure inside `entriesCiphertext` (decrypted under the VEK). See
// docs/p2p-sync.md. Replaces the bare `EncryptedEntry[]` with a wrapper that
// also carries deletion tombstones, so deletes survive a merge instead of being
// silently re-added by a stale peer. Lives in the encrypted payload, so the
// VLT1 binary container in vault-format.ts is unchanged.

import { z } from "zod";
import { EncryptedEntrySchema } from "../vault-format";
import { HlcSchema } from "./hlc";

/** A deletion record: the deleted id and the stamp at which it was deleted. */
export const TombstoneSchema = z.object({
	id: z.string(),
	hlc: HlcSchema,
});
export type Tombstone = z.infer<typeof TombstoneSchema>;

/** The decrypted entries payload: live entries plus the deletion graveyard. */
export const EntriesPayloadSchema = z.object({
	entries: z.array(EncryptedEntrySchema),
	tombstones: z.array(TombstoneSchema),
});
export type EntriesPayload = z.infer<typeof EntriesPayloadSchema>;

/** An empty payload, for a fresh vault. */
export function emptyEntriesPayload(): EntriesPayload {
	return { entries: [], tombstones: [] };
}

/** Serialize a payload to the JSON that gets encrypted under the VEK. */
export function encodeEntriesPayload(payload: EntriesPayload): string {
	return JSON.stringify(EntriesPayloadSchema.parse(payload));
}

/** Parse and validate a decrypted payload. Throws on the legacy bare-array shape. */
export function decodeEntriesPayload(json: string): EntriesPayload {
	return EntriesPayloadSchema.parse(JSON.parse(json));
}
