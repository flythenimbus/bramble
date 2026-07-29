// The pairing SAS: 12 decimal digits both devices derive independently after the enrollment
// handshake, for the user to compare before the vault leaves the inviter. It is the check that
// turns "whoever holds the code gets the vault" into "whoever holds the code AND is the device
// the user is looking at gets the vault" (GHSA-x4f5-4wq4-c6c8). See docs/p2p-sync.md.
//
// Derived from the two Noise static public keys and the invite PSK, NOT from the Noise handshake
// hash: snow::TransportState doesn't expose it and core-rust drops it at into_transport_mode(),
// so using it would mean a Rust change plus a wasm rebuild plus uniffi bindgen plus three mobile
// bridge layers. The statics are equally sound here, because XXpsk3's es/se DHs prove each party
// owns the private key for the static it presented: an interposer has to present a DIFFERENT
// static, which changes the SAS. Sorting the two keys makes both sides agree without a role rule.
//
// crypto.subtle rather than the wasm, matching nostr.ts. That also keeps it working under iOS
// Lockdown Mode, which disables WASM but not WebCrypto.

import { base64ToBytes } from "../util/bytes";

const SAS_INFO = "bramble/sync/sas/v1";
const SAS_DIGITS = 12;
const GROUP = 4;

// crypto.subtle wants BufferSource; our Uint8Arrays are ArrayBufferLike-backed, which newer
// TS lib.dom types reject without a cast (same shim as nostr.ts).
const buf = (b: Uint8Array): BufferSource => b as BufferSource;

/**
 * The short authentication string for one pairing, as "NNNN NNNN NNNN".
 *
 * Symmetric in the two public keys, so inviter and joiner can pass their own key first.
 * ~39.9 bits, which is comfortable rather than marginal here: grinding a short SAS requires the
 * attacker to be BOTH peers, and the joiner already pins the inviter's key from the pairing code,
 * so it can only ever be one. Decimal digits rather than emoji or words because they render
 * identically on every platform and need no name table translated per locale.
 */
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
	// 2^64 is not a multiple of 10^12, so this is very slightly biased (~1 part in 18M). That is
	// far below what matters for a value an attacker gets one attempt at.
	const digits = (n % 10n ** BigInt(SAS_DIGITS)).toString().padStart(SAS_DIGITS, "0");
	return [digits.slice(0, GROUP), digits.slice(GROUP, 2 * GROUP), digits.slice(2 * GROUP)].join(
		" ",
	);
}
