// Enrollment data: the pairing code a new device receives out-of-band, and the
// bundle the inviter hands it over the authenticated channel. The paste code
// deliberately does NOT contain the VEK: it only bootstraps the PSK handshake
// (see handshake XXpsk3), after which the VEK + roster + entries flow over the
// encrypted transport. So a leaked code is not a leaked vault. See docs/p2p-sync.md.

import { z } from "zod";
import { bytesToBase64 } from "../util/bytes";
import { EntriesPayloadSchema } from "./entries-payload";
import { RosterPayloadSchema } from "./roster";

const PAIRING_PREFIX = "bramble-pair-1.";

/** 32 random bytes, base64. Used for the group key and the one-time pairing PSK. */
export function randomKeyB64(len = 32): string {
	return bytesToBase64(crypto.getRandomValues(new Uint8Array(len)));
}

/** The out-of-band pairing code (paste or QR). No vault secrets ride here. */
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
});
export type PairingCode = z.infer<typeof PairingCodeSchema>;

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
export const EnrollmentBundleSchema = z.object({
	/** The shared VEK (base64), wrapped by the channel encryption in transit. */
	vek: z.string().min(1),
	roster: RosterPayloadSchema,
	entries: EntriesPayloadSchema,
});
export type EnrollmentBundle = z.infer<typeof EnrollmentBundleSchema>;

export function encodeEnrollmentBundle(bundle: EnrollmentBundle): string {
	return JSON.stringify(EnrollmentBundleSchema.parse(bundle));
}

export function decodeEnrollmentBundle(json: string): EnrollmentBundle {
	return EnrollmentBundleSchema.parse(JSON.parse(json));
}
