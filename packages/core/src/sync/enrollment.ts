// Enrollment data: the out-of-band pairing code, and the bundle the inviter hands over.
//
// SECURITY: the code carries no VEK but IS a bearer secret worth the vault, since its PSK is the
// sole authenticator of the joiner. What limits the damage is the invite lifecycle (expiry,
// single use, the SAS gate), not the code's contents. See docs/p2p-sync.md "Pairing code".

import { z } from "zod";
import { bytesToBase64 } from "../util/bytes";
import { EntriesPayloadSchema } from "./entries-payload";
import { RosterPayloadSchema } from "./roster";

const PAIRING_PREFIX = "bramble-pair-1.";

/** 32 random bytes, base64. Used for the group key and the one-time pairing PSK. */
export function randomKeyB64(len = 32): string {
	return bytesToBase64(crypto.getRandomValues(new Uint8Array(len)));
}

/** How long an invite is valid. Short on purpose: the code is a bearer credential, so its
 * window should be roughly "while the user is holding up the QR", not "until the app closes". */
export const INVITE_TTL_MS = 3 * 60_000;

/** Tolerance for the joiner's clock running fast when it checks `exp`. The real enforcement is
 * the inviter's LOCAL timer (see startEnroll), which no clock skew can stretch; this check only
 * buys a readable "that code has expired" instead of a silent connect that goes nowhere. */
const EXPIRY_GRACE_MS = 60_000;

/** The out-of-band pairing code (paste or QR). Carries no vault secrets directly, but its
 * `psk` authenticates the joiner, so a live code is worth the vault. See the file header. */
export const PairingCodeSchema = z.object({
	v: z.literal(1),
	/** Group key (base64): derives the signaling room id and encrypts signaling. */
	groupKey: z.string().min(1),
	/** Inviter's Noise static public key (base64); the joiner verifies the peer. */
	inviterPub: z.string().min(1),
	/** One-time pairing secret (base64, 32 bytes) used as the enrollment PSK. */
	psk: z.string().min(1),
	/** Relay URL the joiner should connect to. */
	relay: z.string().min(1),
	/** ICE-servers (STUN/TURN) endpoint to adopt; omitted derives it from the relay. */
	iceUrl: z.string().optional(),
	/** Epoch ms this invite stops being valid. Optional so it is purely additive: zod strips
	 * unknown keys, so a build that predates it parses a code carrying it and ignores it (which
	 * is safe — the inviter enforces expiry with its own timer either way). */
	exp: z.number().int().positive().optional(),
});
export type PairingCode = z.infer<typeof PairingCodeSchema>;

/** True when this code's window has passed, so the joiner can refuse it before prompting for a
 * password or spinning up a mesh. A code without `exp` (an older inviter) never expires here;
 * that inviter has no deadline to honour anyway. */
export function pairingCodeExpired(
	code: PairingCode,
	nowMs: number = Date.now(),
	graceMs: number = EXPIRY_GRACE_MS,
): boolean {
	return code.exp !== undefined && nowMs - graceMs > code.exp;
}

/** Serialize a pairing code to a compact, prefixed string. */
export function encodePairingCode(code: PairingCode): string {
	const json = JSON.stringify(PairingCodeSchema.parse(code));
	return PAIRING_PREFIX + bytesToBase64(new TextEncoder().encode(json));
}

/** Parse a pairing code; throws on a wrong prefix or malformed body. */
export function decodePairingCode(text: string): PairingCode {
	const trimmed = text.trim();
	if (!trimmed.startsWith(PAIRING_PREFIX)) throw new Error("not a bramble pairing code");
	const body = trimmed.slice(PAIRING_PREFIX.length);
	const json = new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)));
	return PairingCodeSchema.parse(JSON.parse(json));
}

/** The handoff sent over the authenticated channel once enrollment connects. */
const EnrollmentBundleSchema = z.object({
	/** The shared VEK (base64), wrapped by the channel encryption in transit. */
	vek: z.string().min(1),
	roster: RosterPayloadSchema,
	entries: EntriesPayloadSchema,
	/** Inviter's password-slot fields (base64), so the joiner can PROVE its typed
	 * password matches the existing device's master password before building the
	 * vault. Optional: absent from a security-key-only inviter or an older build, in
	 * which case the joiner falls back to its local confirm-password guard. */
	primaryPasswordCheck: z
		.object({ saltB64: z.string(), slotIdB64: z.string(), verifierB64: z.string() })
		.optional(),
	/** The inviter's recovery slot(s) (base64), copied verbatim into the joiner's vault so the
	 * group's recovery code unlocks every device. Safe to forward: the slot only wraps the VEK, which
	 * the bundle already carries. Absent when the inviter has no recovery code. See docs/p2p-sync.md. */
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
});
export type EnrollmentBundle = z.infer<typeof EnrollmentBundleSchema>;

/** A recovery slot serialized (base64) for transport in the enrollment bundle. */
export type WireRecoverySlot = NonNullable<EnrollmentBundle["recoverySlots"]>[number];

export function encodeEnrollmentBundle(bundle: EnrollmentBundle): string {
	return JSON.stringify(EnrollmentBundleSchema.parse(bundle));
}

export function decodeEnrollmentBundle(json: string): EnrollmentBundle {
	return EnrollmentBundleSchema.parse(JSON.parse(json));
}
