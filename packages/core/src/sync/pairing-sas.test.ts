import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../util/bytes";
import { pairingSas } from "./pairing-sas";

const key = (fill: number) => bytesToBase64(new Uint8Array(32).fill(fill));

const PSK = key(1);
const INVITER = key(2);
const JOINER = key(3);

describe("pairingSas", () => {
	it("is symmetric in the two keys, so both roles derive the same value", async () => {
		expect(await pairingSas(PSK, INVITER, JOINER)).toBe(await pairingSas(PSK, JOINER, INVITER));
	});

	it("changes when the peer's key changes (the MITM case it exists to catch)", async () => {
		const real = await pairingSas(PSK, INVITER, JOINER);
		const impostor = await pairingSas(PSK, INVITER, key(4));
		expect(impostor).not.toBe(real);
	});

	it("changes when the PSK changes, so two invites never show the same number", async () => {
		expect(await pairingSas(key(9), INVITER, JOINER)).not.toBe(
			await pairingSas(PSK, INVITER, JOINER),
		);
	});

	it("is 12 digits in three groups of four", async () => {
		expect(await pairingSas(PSK, INVITER, JOINER)).toMatch(/^\d{4} \d{4} \d{4}$/);
	});

	it("zero-pads rather than shortening", async () => {
		// Every derivation must be exactly 12 digits: a value that happened to be small would
		// otherwise render shorter on one device than the other and look like a mismatch.
		for (let i = 0; i < 64; i++) {
			expect(await pairingSas(PSK, INVITER, key(i))).toMatch(/^\d{4} \d{4} \d{4}$/);
		}
	});

	// Pinned so the derivation cannot drift: the extension (offscreen), iOS and Android each run
	// this over their own WebCrypto, and a change here silently breaks pairing between platforms
	// rather than failing loudly. Regenerate ONLY alongside a deliberate, versioned info-string bump.
	it("matches the pinned vector", async () => {
		expect(await pairingSas(PSK, INVITER, JOINER)).toBe("2030 9556 3233");
	});
});
