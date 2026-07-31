// The pairing SAS: 12 digits both devices derive after the handshake, for the user to compare
// before the vault leaves the inviter. Derived from the two Noise statics + the invite PSK rather
// than the handshake hash, which core-rust drops at into_transport_mode(). crypto.subtle (as in
// nostr.ts), so it survives iOS Lockdown Mode. See docs/p2p-sync.md "Pairing code".

import { base64ToBytes } from "../util/bytes";

const SAS_INFO = "bramble/sync/sas/v1";
const SAS_DIGITS = 12;
const GROUP = 4;

// crypto.subtle wants BufferSource; our Uint8Arrays are ArrayBufferLike-backed, which newer
// TS lib.dom types reject without a cast (same shim as nostr.ts).
const buf = (b: Uint8Array): BufferSource => b as BufferSource;

/** "NNNN NNNN NNNN" for one pairing. Symmetric in the two keys, so either side can pass its own
 * first. ~40 bits, ample because grinding needs the attacker to be both peers and the joiner's
 * pin prevents that. */
export async function pairingSas(pskB64: string, pubA: string, pubB: string): Promise<string> {
	const base = await crypto.subtle.importKey("raw", buf(base64ToBytes(pskB64)), "HKDF", false, [
		"deriveBits",
	]);
	const encoder = new TextEncoder();
	const bits = await crypto.subtle.deriveBits(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: buf(encoder.encode([pubA, pubB].sort().join(""))),
			info: buf(encoder.encode(SAS_INFO)),
		},
		base,
		64,
	);
	let n = 0n;
	for (const byte of new Uint8Array(bits)) n = (n << 8n) | BigInt(byte);
	// Slight modulo bias (~1 part in 18M), irrelevant for a value with one attempt at it.
	const digits = (n % 10n ** BigInt(SAS_DIGITS)).toString().padStart(SAS_DIGITS, "0");
	return [digits.slice(0, GROUP), digits.slice(GROUP, 2 * GROUP), digits.slice(2 * GROUP)].join(
		" ",
	);
}
