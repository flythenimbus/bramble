import { describe, expect, it } from "vitest";
import {
	decodeVaultBlob,
	encodeVaultBlob,
	LEN_IV,
	LEN_SALT,
	LEN_VERIFIER,
	MAGIC,
	OFFSET_ENTRIES,
	OFFSET_VERSION,
	type VaultBlob,
	VERSION,
} from "./vault-format";

function fillBytes(length: number, base = 0): Uint8Array {
	const arr = new Uint8Array(length);
	for (let i = 0; i < length; i++) arr[i] = (base + i) & 0xff;
	return arr;
}

function makeBlob(entriesLen = 32): VaultBlob {
	return {
		salt: fillBytes(LEN_SALT, 0x10),
		verifier: fillBytes(LEN_VERIFIER, 0x20),
		entriesIv: fillBytes(LEN_IV, 0x30),
		entriesCiphertext: fillBytes(entriesLen, 0x40),
	};
}

describe("encodeVaultBlob", () => {
	it("starts with magic + version", () => {
		const out = encodeVaultBlob(makeBlob());
		expect(out.subarray(0, 4)).toEqual(MAGIC);
		expect(out[OFFSET_VERSION]).toBe(VERSION);
	});

	it("output length matches header + ciphertext", () => {
		const out = encodeVaultBlob(makeBlob(100));
		expect(out.length).toBe(OFFSET_ENTRIES + 100);
	});

	it("accepts zero-length entries ciphertext", () => {
		const out = encodeVaultBlob(makeBlob(0));
		expect(out.length).toBe(OFFSET_ENTRIES);
	});

	it("rejects wrong-length salt", () => {
		const blob = { ...makeBlob(), salt: new Uint8Array(LEN_SALT - 1) };
		expect(() => encodeVaultBlob(blob)).toThrow(/salt/);
	});

	it("rejects wrong-length verifier", () => {
		const blob = { ...makeBlob(), verifier: new Uint8Array(LEN_VERIFIER - 1) };
		expect(() => encodeVaultBlob(blob)).toThrow(/verifier/);
	});

	it("rejects wrong-length iv", () => {
		const blob = { ...makeBlob(), entriesIv: new Uint8Array(LEN_IV - 1) };
		expect(() => encodeVaultBlob(blob)).toThrow(/entriesIv/);
	});
});

describe("decodeVaultBlob", () => {
	it("roundtrips a populated blob", () => {
		const blob = makeBlob(42);
		const decoded = decodeVaultBlob(encodeVaultBlob(blob));
		expect(decoded.salt).toEqual(blob.salt);
		expect(decoded.verifier).toEqual(blob.verifier);
		expect(decoded.entriesIv).toEqual(blob.entriesIv);
		expect(decoded.entriesCiphertext).toEqual(blob.entriesCiphertext);
	});

	it("roundtrips an empty entries blob", () => {
		const decoded = decodeVaultBlob(encodeVaultBlob(makeBlob(0)));
		expect(decoded.entriesCiphertext.length).toBe(0);
	});

	it("rejects too-short input", () => {
		expect(() => decodeVaultBlob(new Uint8Array(OFFSET_ENTRIES - 1))).toThrow(/short/);
	});

	it("rejects wrong magic", () => {
		const out = encodeVaultBlob(makeBlob());
		out[0] = 0x00;
		expect(() => decodeVaultBlob(out)).toThrow(/magic/);
	});

	it("rejects unknown version", () => {
		const out = encodeVaultBlob(makeBlob());
		out[OFFSET_VERSION] = 0xff;
		expect(() => decodeVaultBlob(out)).toThrow(/version/);
	});

	it("returns copies, not views into the input buffer", () => {
		const out = encodeVaultBlob(makeBlob());
		const decoded = decodeVaultBlob(out);
		const beforeSalt0 = decoded.salt[0];
		out[5] = (beforeSalt0 ?? 0) ^ 0xff;
		expect(decoded.salt[0]).toBe(beforeSalt0);
	});
});
