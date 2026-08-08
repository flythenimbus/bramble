// The pairing SAS: a value both devices derive after the handshake, for the user to compare before
// the vault leaves the inviter. Derived from the two Noise statics + the invite PSK rather than the
// handshake hash, which core-rust drops at into_transport_mode(). crypto.subtle (as in nostr.ts),
// so it survives iOS Lockdown Mode. See docs/p2p-sync.md "Pairing code".
//
// Two representations of the SAME 64 derived bits, so both are equally strong and a device
// showing one can be checked against a device showing the other:
//
//  - `emoji`, seven symbols, the comparison users actually make. See ./sas-emoji.
//  - `digits`, twelve of them, what every released client showed before the emoji SAS existed.
//    Kept and still displayed, because comparison is between TWO devices and one of them may not
//    have updated yet. An older peer shows only digits; without them there is nothing to compare
//    and the user's options are to guess or to give up. Drop it once no supported version is
//    digits-only.
//
// The derivation is deliberately unchanged (same info string, same inputs), because changing it
// would break exactly the cross-version comparison the digits exist to preserve.

import { base64ToBytes } from "../util/bytes";
import { SAS_EMOJI_LEN } from "./sas-emoji";

const SAS_INFO = "bramble/sync/sas/v1";
const SAS_DIGITS = 12;
const GROUP = 4;
/** 6 bits per symbol, which is why the alphabet is exactly 64 long. */
const BITS_PER_EMOJI = 6;

// crypto.subtle wants BufferSource; our Uint8Arrays are ArrayBufferLike-backed, which newer
// TS lib.dom types reject without a cast (same shim as nostr.ts).
const buf = (b: Uint8Array): BufferSource => b as BufferSource;

export interface PairingSas {
	/** Seven indices into SAS_EMOJI. Taken as raw bit groups, so unlike the digits there is no
	 * modulo bias at all. */
	emoji: number[];
	/** "NNNN NNNN NNNN". The pre-emoji representation, for comparing against an older device. */
	digits: string;
}

/** Read `count` groups of `width` bits from the front of `bytes`, most significant first. */
function bitGroups(bytes: Uint8Array, width: number, count: number): number[] {
	const out: number[] = [];
	let acc = 0;
	let have = 0;
	for (const byte of bytes) {
		acc = (acc << 8) | byte;
		have += 8;
		while (have >= width && out.length < count) {
			have -= width;
			out.push((acc >>> have) & ((1 << width) - 1));
		}
		// Keep only the bits not yet emitted, so acc cannot overflow 32 bits.
		acc &= (1 << have) - 1;
		if (out.length === count) break;
	}
	return out;
}

/**
 * The SAS for one pairing. Symmetric in the two keys, so either side can pass its own first.
 *
 * ~40 bits as digits, 42 as emoji: ample, because grinding it needs the attacker to be both peers,
 * and the joiner's pin prevents that.
 */
export async function pairingSas(pskB64: string, pubA: string, pubB: string): Promise<PairingSas> {
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
	const bytes = new Uint8Array(bits);
	let n = 0n;
	for (const byte of bytes) n = (n << 8n) | BigInt(byte);
	// Slight modulo bias (~1 part in 18M), irrelevant for a value with one attempt at it.
	const digits = (n % 10n ** BigInt(SAS_DIGITS)).toString().padStart(SAS_DIGITS, "0");
	return {
		emoji: bitGroups(bytes, BITS_PER_EMOJI, SAS_EMOJI_LEN),
		digits: [digits.slice(0, GROUP), digits.slice(GROUP, 2 * GROUP), digits.slice(2 * GROUP)].join(
			" ",
		),
	};
}
