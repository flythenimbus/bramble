import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import { linkSas, linkSasMaterial } from "./link-sas";
import { sasFromBits } from "./pairing-sas";

/** The 64 bits the link emoji come from, computed here independently of link-sas.ts. */
async function expectedBits(hashB64: string): Promise<Uint8Array> {
	const base = await crypto.subtle.importKey(
		"raw",
		base64ToBytes(hashB64) as BufferSource,
		"HKDF",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new Uint8Array() as BufferSource,
			info: new TextEncoder().encode("bramble/link/sas/v1") as BufferSource,
		},
		base,
		64,
	);
	return new Uint8Array(bits);
}

const HASH_A = bytesToBase64(new Uint8Array(32).map((_, i) => i));
const HASH_B = bytesToBase64(new Uint8Array(32).map((_, i) => 255 - i));

describe("linkSas", () => {
	it("is HKDF of the handshake hash under the link info string", async () => {
		expect(await linkSas(HASH_A)).toEqual(sasFromBits(await expectedBits(HASH_A)));
	});

	it("gives seven emoji and twelve digits, the same shape as the sync SAS", async () => {
		const sas = await linkSas(HASH_A);
		expect(sas.emoji).toHaveLength(7);
		expect(sas.digits).toMatch(/^\d{4} \d{4} \d{4}$/);
	});

	it("differs for a different handshake", async () => {
		expect((await linkSas(HASH_A)).digits).not.toBe((await linkSas(HASH_B)).digits);
	});
});

describe("linkSasMaterial", () => {
	it("binds the handshake hash and both nonces, matching the desktop app byte for byte", async () => {
		const fill = (n: number) => bytesToBase64(new Uint8Array(32).fill(n));
		// The same vector is asserted in the desktop's socket.rs tests.
		expect(await linkSasMaterial(fill(1), fill(2), fill(3))).toBe(
			"S8naVfRk7bIlPFMxZJojFyQc+1fyQSEaCA2PzZ4RjDs=",
		);
	});

	it("changes with either nonce", async () => {
		const fill = (n: number) => bytesToBase64(new Uint8Array(32).fill(n));
		const base = await linkSasMaterial(fill(1), fill(2), fill(3));
		expect(await linkSasMaterial(fill(1), fill(9), fill(3))).not.toBe(base);
		expect(await linkSasMaterial(fill(1), fill(2), fill(9))).not.toBe(base);
	});
});
