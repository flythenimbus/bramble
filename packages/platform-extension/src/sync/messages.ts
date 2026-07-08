// The SYNC_* wire protocol: one home for the payloads that cross the
// popup <-> background <-> offscreen contexts. chrome.runtime delivers untyped
// objects, so each structured payload is validated with zod at the receiving seam
// (the offscreen + background handlers) rather than trust-spread, and producers
// build payloads against the inferred types. The popup itself is insulated by
// ShellAdapter; this is the platform-internal contract behind it. The older
// CRYPTO_* family is out of scope here. See docs/p2p-sync.md.

import { EntriesPayloadSchema, RosterEntrySchema, RosterPayloadSchema } from "@core/sync";
import { z } from "zod";

/** background -> offscreen: start the continuous roster-sync host. */
export const RosterSyncMsgSchema = z.object({
	relayUrl: z.string(),
	iceUrl: z.string().optional(),
	groupKeyB64: z.string(),
	roster: RosterPayloadSchema,
	devicePrivB64: z.string(),
	devicePubB64: z.string(),
});
export type RosterSyncMsg = z.infer<typeof RosterSyncMsgSchema>;

/** popup -> background -> offscreen: start enrollment as the inviter. The
 * background injects devicePrivB64; the popup never sees the private key. */
export const EnrollInviteMsgSchema = z.object({
	relayUrl: z.string(),
	iceUrl: z.string().optional(),
	groupKeyB64: z.string(),
	psk: z.string(),
	devicePrivB64: z.string(),
	roster: RosterPayloadSchema,
	entries: EntriesPayloadSchema,
	passwordCheck: z
		.object({ saltB64: z.string(), slotIdB64: z.string(), verifierB64: z.string() })
		.optional(),
});
export type EnrollInviteMsg = z.infer<typeof EnrollInviteMsgSchema>;

/** popup -> background -> offscreen: start enrollment as the joiner. The rebuilt
 * vault is unlocked by a password OR a security-key slot (exactly one is sent). */
export const EnrollJoinMsgSchema = z.object({
	relayUrl: z.string(),
	iceUrl: z.string().optional(),
	groupKeyB64: z.string(),
	psk: z.string(),
	devicePrivB64: z.string(),
	inviterPub: z.string(),
	ownEntry: RosterEntrySchema,
	password: z.string().optional(),
	webauthn: z
		.object({
			hmacSecretB64: z.string(),
			credentialIdB64: z.string(),
			saltB64: z.string(),
		})
		.optional(),
});
export type EnrollJoinMsg = z.infer<typeof EnrollJoinMsgSchema>;

/** offscreen -> background: a peer's entries payload (JSON) to merge locally. */
export const ApplyRemoteMsgSchema = z.object({ payloadJson: z.string() });
export type ApplyRemoteMsg = z.infer<typeof ApplyRemoteMsgSchema>;

/** offscreen -> background: a peer's roster (JSON) to merge locally (revocations propagate). */
export const ApplyRosterMsgSchema = z.object({ rosterJson: z.string() });
export type ApplyRosterMsg = z.infer<typeof ApplyRosterMsgSchema>;

/** shell -> background (SYNC_SIGN_ENTRY): the canonical roster-entry string to Ed25519-sign. */
export const RosterSignEntryMsgSchema = z.object({ canonical: z.string() });
export type RosterSignEntryMsg = z.infer<typeof RosterSignEntryMsgSchema>;

/** background -> offscreen (SYNC_ROSTER_SIGN): the Ed25519 seed + the message to sign. */
export const RosterSignHostMsgSchema = z.object({ secretB64: z.string(), message: z.string() });
export type RosterSignHostMsg = z.infer<typeof RosterSignHostMsgSchema>;

/** offscreen -> popup broadcast: a structured enrollment event. Mirrors core's SyncEvent. */
export const SyncEventMsgSchema = z.object({
	kind: z.string(),
	vaultBlobB64: z.string().optional(),
	roster: RosterPayloadSchema.optional(),
	entryJson: z.string().optional(),
	message: z.string().optional(),
});
export type SyncEventMsg = z.infer<typeof SyncEventMsgSchema>;

/** offscreen -> popup broadcast: a human-readable status line for the dev panel. */
export const SyncStatusMsgSchema = z.object({ status: z.string() });
export type SyncStatusMsg = z.infer<typeof SyncStatusMsgSchema>;
