// The structure inside `entriesCiphertext` (decrypted under the VEK). See
// docs/p2p-sync.md. Replaces the bare `EncryptedEntry[]` with a wrapper that
// also carries deletion tombstones, so deletes survive a merge instead of being
// silently re-added by a stale peer. Lives in the encrypted payload, so the
// VLT1 binary container in vault-format.ts is unchanged.

import { z } from "zod";
import { EncryptedEntrySchema } from "../vault-format";
import { isFutureVersion, VersionVectorSchema } from "./causal";
import { HlcSchema, isFutureStamp } from "./hlc";

/** A deletion record: the deleted id and the stamp at which it was deleted. */
export const TombstoneSchema = z.object({
	id: z.string(),
	hlc: HlcSchema,
	// The joined history of every delete of this id; absent on one from an older build.
	vv: VersionVectorSchema.optional(),
	floor: HlcSchema.optional(),
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

/** A blob's address: lowercase hex SHA-256. Exported so the manifest schema and the blob store
 * validate the same shape, since it is both a record field and a filesystem key. */
export const BLOB_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * One file attachment's manifest entry. The bytes are NOT here: they live in the blob store,
 * addressed by `hash`, and never ride this payload, which is rewritten on every entry edit and
 * rebroadcast to every peer every few seconds. See docs/file-attachments.md.
 *
 * `hash` and `size` sit outside the sealed metadata on purpose: the transfer layer needs them to
 * decide what to fetch and to verify what arrived, and keeping them in the clear (under the VEK,
 * like everything else here) is what lets blobs move without any key entering the transfer code.
 * Name and MIME type stay sealed in `metaBlob`, because a filename is often the whole secret.
 */
export const FileRecordSchema = z.object({
	id: z.string(),
	hlc: HlcSchema,
	/** The owning entry, or absent for a standalone Files item. */
	entryId: z.string().optional(),
	/** Lowercase hex SHA-256 of the sealed blob. Hex, not base64, because this is also the blob's
	 * filename on the mobile and desktop stores, and base64's `/` and `+` are not filename-safe. */
	hash: z.string().regex(BLOB_HASH_RE, "hash must be lowercase hex sha-256"),
	/** Sealed blob length in bytes (plaintext plus one AEAD tag per chunk). */
	size: z.number().int().nonnegative(),
	/** The file's FEK, wrapped under the VEK exactly as an entry's DEK is. */
	wrappedFek: z.string(),
	fekIv: z.string(),
	/**
	 * The 7-byte STREAM nonce prefix, base64. In the clear like every other IV here
	 * (`fekIv`, `metaIv`, an entry's `dekIv`), because a nonce is not a secret.
	 *
	 * Keeping it out of the sealed metadata is also what lets TypeScript build that metadata
	 * before sealing starts, which is the codebase's convention: Rust seals a string it was
	 * handed, it does not construct JSON. The chunk count is likewise absent, being a pure
	 * function of `size` (`chunk_count_from_sealed`).
	 */
	noncePrefix: z.string(),
	/** {name, mime, plaintextSize}, sealed under the FEK's meta subkey. */
	metaBlob: z.string(),
	metaIv: z.string(),
});
export type FileRecord = z.infer<typeof FileRecordSchema>;

/** The decrypted entries payload: displayed entries, the deletion graveyard, any vault-scoped
 * settings, the concurrent versions not displayed (`conflicts`, still sealed), and the file
 * manifest. The optional fields let a payload written before they existed still parse.
 *
 * File deletions get their own graveyard rather than sharing `tombstones`. Entry ids and file
 * ids are separate namespaces, so one list would make every entry's liveness check consult
 * deletions that can never apply to it, and would grow the entry graveyard with file churn.
 *
 * `fileCascades` marks each file a deleted entry took with it: one per attachment the deleting
 * device held. The record stays in `files`, so keeping a delete-conflicted entry brings its
 * files back, and a file with no mark was attached where the delete couldn't see it. See
 * docs/file-attachments.md, "Deleting an entry hides its attachments". */
export const EntriesPayloadSchema = z.object({
	entries: z.array(EncryptedEntrySchema),
	tombstones: z.array(TombstoneSchema),
	settings: SyncedSettingsSchema.optional(),
	files: z.array(FileRecordSchema).optional(),
	fileTombstones: z.array(TombstoneSchema).optional(),
	fileCascades: z.array(TombstoneSchema).optional(),
	conflicts: z.array(EncryptedEntrySchema).optional(),
});
export type EntriesPayload = z.infer<typeof EntriesPayloadSchema>;

/** The file-manifest half of a payload. One value because the records, their graveyard and the
 * cascade marks have to be carried together or a delete is lost, and because every writer that
 * rebuilds a payload has to thread all three through. */
export type FileManifest = Pick<EntriesPayload, "files" | "fileTombstones" | "fileCascades">;

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
	// Files get the same guard: a future-stamped FileRecord would be an attachment no device
	// could delete, and a future-stamped fileTombstone would make one permanently unrestorable.
	const files = payload.files?.filter((f) => !isFutureStamp(f.hlc, now));
	const fileTombstones = payload.fileTombstones?.filter((t) => !isFutureStamp(t.hlc, now));
	const fileCascades = payload.fileCascades?.filter((t) => !isFutureStamp(t.hlc, now));
	const conflicts = payload.conflicts?.filter((e) => !isFutureVersion(e, now));
	return {
		entries: payload.entries.filter((e) => !isFutureVersion(e, now)),
		tombstones: payload.tombstones.filter((t) => !isFutureVersion(t, now)),
		...(settings ? { settings } : {}),
		...(files ? { files } : {}),
		...(fileTombstones ? { fileTombstones } : {}),
		...(fileCascades ? { fileCascades } : {}),
		...(conflicts ? { conflicts } : {}),
	};
}
