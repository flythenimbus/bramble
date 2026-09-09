// The structure inside `entriesCiphertext` (decrypted under the VEK). See
// docs/p2p-sync.md. Replaces the bare `EncryptedEntry[]` with a wrapper that
// also carries deletion tombstones, so deletes survive a merge instead of being
// silently re-added by a stale peer. Lives in the encrypted payload, so the
// VLT1 binary container in vault-format.ts is unchanged.

import { z } from "zod";
import { EncryptedEntrySchema } from "../vault-format";
import { HlcSchema, isFutureStamp } from "./hlc";

/** A deletion record: the deleted id and the stamp at which it was deleted. */
export const TombstoneSchema = z.object({
	id: z.string(),
	hlc: HlcSchema,
});
export type Tombstone = z.infer<typeof TombstoneSchema>;

/**
 * One synced setting: a stamped value, keyed by the pref's own meta key.
 *
 * `value: null` means the user explicitly cleared it. That is deliberately NOT the same as the
 * key being absent, because absence is what a client predating this map produces when it strips
 * and rewrites the payload. Absent means "no opinion"; null means "turned off". See
 * docs/synced-settings.md.
 */
export const SyncedSettingSchema = z.object({
	hlc: HlcSchema,
	value: z.unknown(),
});

/** Settings that belong to the vault rather than the device, merged like any replicated state. */
export const SyncedSettingsSchema = z.record(z.string(), SyncedSettingSchema);
export type SyncedSettings = z.infer<typeof SyncedSettingsSchema>;

/** The decrypted entries payload: live entries, the deletion graveyard, and any vault-scoped
 * settings. `settings` is optional so a payload written before it existed still parses. */
export const EntriesPayloadSchema = z.object({
	entries: z.array(EncryptedEntrySchema),
	tombstones: z.array(TombstoneSchema),
	settings: SyncedSettingsSchema.optional(),
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

/** Drop entries and tombstones stamped implausibly far in the future before merging a
 * REMOTELY-received payload, so a member can't pin an un-deletable entry by stamping it years
 * ahead (mirrors the roster guard). Honest payloads carry near-present stamps. */
export function sanitizeRemoteEntriesPayload(
	payload: EntriesPayload,
	now: number = Date.now(),
): EntriesPayload {
	const settings = payload.settings
		? Object.fromEntries(
				Object.entries(payload.settings).filter(([, rec]) => !isFutureStamp(rec.hlc, now)),
			)
		: undefined;
	return {
		entries: payload.entries.filter((e) => !isFutureStamp(e.hlc, now)),
		tombstones: payload.tombstones.filter((t) => !isFutureStamp(t.hlc, now)),
		...(settings ? { settings } : {}),
	};
}
