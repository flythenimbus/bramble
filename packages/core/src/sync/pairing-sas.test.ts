import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../util/bytes";
import { pairingSas } from "./pairing-sas";
import { SAS_EMOJI, SAS_EMOJI_LEN } from "./sas-emoji";

const key = (fill: number) => bytesToBase64(new Uint8Array(32).fill(fill));

const PSK = key(1);
const INVITER = key(2);
const JOINER = key(3);

describe("pairingSas", () => {
	it("is symmetric in the two keys, so both roles derive the same value", async () => {
		expect(await pairingSas(PSK, INVITER, JOINER)).toEqual(await pairingSas(PSK, JOINER, INVITER));
	});

	it("changes when the peer's key changes (the MITM case it exists to catch)", async () => {
		const real = await pairingSas(PSK, INVITER, JOINER);
		const impostor = await pairingSas(PSK, INVITER, key(4));
		expect(impostor.digits).not.toBe(real.digits);
		expect(impostor.emoji).not.toEqual(real.emoji);
	});

	it("changes when the PSK changes, so two invites never show the same value", async () => {
		const other = await pairingSas(key(9), INVITER, JOINER);
		const real = await pairingSas(PSK, INVITER, JOINER);
		expect(other.digits).not.toBe(real.digits);
		expect(other.emoji).not.toEqual(real.emoji);
	});

	it("is 12 digits in three groups of four", async () => {
		expect((await pairingSas(PSK, INVITER, JOINER)).digits).toMatch(/^\d{4} \d{4} \d{4}$/);
	});

	it("zero-pads rather than shortening", async () => {
		// Every derivation must be exactly 12 digits: a value that happened to be small would
		// otherwise render shorter on one device than the other and look like a mismatch.
		for (let i = 0; i < 64; i++) {
			expect((await pairingSas(PSK, INVITER, key(i))).digits).toMatch(/^\d{4} \d{4} \d{4}$/);
		}
	});

	it("emits seven in-range emoji indices", async () => {
		// Out of range would render as a gap on one device and a symbol on the other, which reads
		// as a mismatch on a screen whose whole job is to be compared.
		for (let i = 0; i < 64; i++) {
			const { emoji } = await pairingSas(PSK, INVITER, key(i));
			expect(emoji).toHaveLength(SAS_EMOJI_LEN);
			for (const index of emoji) {
				expect(Number.isInteger(index)).toBe(true);
				expect(index).toBeGreaterThanOrEqual(0);
				expect(index).toBeLessThan(SAS_EMOJI.length);
			}
		}
	});

	// Pinned so the derivation cannot drift: the extension (offscreen), iOS, Android and the desktop
	// each run this over their own WebCrypto, and a change here silently breaks pairing between
	// platforms rather than failing loudly. The digits are ALSO the cross-version comparison, so this
	// vector is what lets a new device pair with a released one. Regenerate ONLY alongside a
	// deliberate, versioned info-string bump.
	it("matches the pinned vector", async () => {
		const sas = await pairingSas(PSK, INVITER, JOINER);
		expect(sas.digits).toBe("2030 9556 3233");
		// Flag, paperclip, octopus, pencil, rocket, book, trumpet: the top 42 bits of the same
		// 64 the digits come from, taken 6 at a time.
		expect(sas.emoji).toEqual([50, 44, 13, 43, 54, 42, 58]);
	});
});

describe("the emoji alphabet", () => {
	it("is exactly 64 long, because an index is 6 bits", async () => {
		// 6 bits addresses 0..63. A shorter table means some derivations point at nothing; a longer
		// one means entries that can never be shown.
		expect(SAS_EMOJI).toHaveLength(64);
	});

	it("has no duplicate symbols", async () => {
		// Two identical glyphs would be indistinguishable on screen, so a mismatch in that position
		// would be invisible to the user.
		expect(new Set(SAS_EMOJI).size).toBe(SAS_EMOJI.length);
	});

	it("has a name for every symbol, and no name serves two", async () => {
		// The names live with the UI, so this is the guard against the two drifting apart: an
		// unnamed symbol renders as a bare glyph with nothing to say out loud, and a shared name
		// makes two symbols indistinguishable when spoken.
		const { sasEmojiNames } = await import("../app/components/SasDisplay");
		for (const char of SAS_EMOJI) expect(sasEmojiNames[char], char).toBeDefined();
		expect(Object.keys(sasEmojiNames)).toHaveLength(SAS_EMOJI.length);
		const names = SAS_EMOJI.map((c) => sasEmojiNames[c]?.message);
		expect(new Set(names).size).toBe(SAS_EMOJI.length);
	});
});
