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
	// This device's own Noise static public key, injected alongside the private one. Half the SAS
	// input, and the host can't derive it from the private key it holds. See @core/sync/pairing-sas.
	devicePubB64: z.string().optional(),
	// The inviter's vault VEK, injected by the background invite handler from the per-vault map
	// (the scratch-slot offscreen can't be trusted to export the right one). See docs/multiple-vaults.md.
	vekB64: z.string().optional(),
	roster: RosterPayloadSchema,
	entries: EntriesPayloadSchema,
	passwordCheck: z
		.object({ saltB64: z.string(), slotIdB64: z.string(), verifierB64: z.string() })
		.optional(),
	recoverySlots: z
		.array(
			z.object({
				saltB64: z.string(),
				slotIdB64: z.string(),
				verifierB64: z.string(),
				wrapIvB64: z.string(),
				wrappedVekB64: z.string(),
			}),
		)
		.optional(),
	// The inviter's admission material so the HOST can admission-sign the joiner and add it to the
	// local roster itself (reliable on Firefox, where the popup can be gone when enrollment finishes).
	// See offscreen-core `addEnrolledToLocalRoster` and docs/multiple-vaults.md.
	admission: z
		.object({ password: z.string(), saltB64: z.string(), adminId: z.string() })
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

/** offscreen -> background: a peer's entries payload (JSON) to merge locally. */
export const ApplyRemoteMsgSchema = z.object({ payloadJson: z.string() });
export type ApplyRemoteMsg = z.infer<typeof ApplyRemoteMsgSchema>;

/** offscreen -> background: a peer's roster (JSON) to merge locally (revocations propagate). */
export const ApplyRosterMsgSchema = z.object({ rosterJson: z.string() });

/** shell -> background (SYNC_SIGN_ENTRY): the canonical roster-entry string to Ed25519-sign. */
export const RosterSignEntryMsgSchema = z.object({ canonical: z.string() });

/** background -> offscreen (SYNC_ROSTER_SIGN): the Ed25519 seed + the message to sign. */
export const RosterSignHostMsgSchema = z.object({ secretB64: z.string(), message: z.string() });

/** shell -> background (SYNC_ADMISSION_PUBKEY) / background -> offscreen (SYNC_ROSTER_ADMISSION_PUBKEY):
 * the re-entered master password + this device's password-slot salt, to derive the admission verify
 * key transiently (never stored). See docs/p2p-sync-revocation-hardening.md. */
export const AdmissionPubkeyMsgSchema = z.object({ password: z.string(), saltB64: z.string() });

/** shell -> background (SYNC_ADMISSION_SIGN): password + salt + the canonical entry to admission-sign. */
export const AdmissionSignEntryMsgSchema = z.object({
	password: z.string(),
	saltB64: z.string(),
	canonical: z.string(),
});

/** background -> offscreen (SYNC_ROSTER_ADMISSION_SIGN): password + salt + the message to sign. */
export const AdmissionSignHostMsgSchema = z.object({
	password: z.string(),
	saltB64: z.string(),
	message: z.string(),
});

/** popup -> background -> offscreen (SYNC_ENROLL_APPROVE): the user's answer to the pairing
 * prompt. The host is holding the joiner with nothing sent; false burns the invite. */
export const EnrollApproveMsgSchema = z.object({ approved: z.boolean() });

/** offscreen -> popup: an approval the host is still waiting on, so a reopened popup can resume
 * the prompt rather than stranding it. Null when there is none. */
export const PendingEnrollApprovalSchema = z
	// sasEmoji is optional so an offscreen that predates the emoji SAS still parses; the popup
	// falls back to comparing digits. See @core/sync/pairing-sas.
	.object({ sas: z.string(), sasEmoji: z.array(z.number().int()).optional(), label: z.string() })
	.nullable();
export type PendingEnrollApproval = z.infer<typeof PendingEnrollApprovalSchema>;

/** offscreen -> popup broadcast: a structured enrollment event. Mirrors core's SyncEvent. */
export const SyncEventMsgSchema = z.object({
	kind: z.string(),
	vaultBlobB64: z.string().optional(),
	roster: RosterPayloadSchema.optional(),
	entryJson: z.string().optional(),
	message: z.string().optional(),
	sas: z.string().optional(),
	sasEmoji: z.array(z.number().int()).optional(),
	label: z.string().optional(),
});
export type SyncEventMsg = z.infer<typeof SyncEventMsgSchema>;

/** offscreen -> popup broadcast: a human-readable status line for the dev panel. */
export const SyncStatusMsgSchema = z.object({ status: z.string() });
export type SyncStatusMsg = z.infer<typeof SyncStatusMsgSchema>;
