import { describe, expect, it } from "vitest";
import {
	decodeEnrollmentBundle,
	decodePairingCode,
	type EnrollmentBundle,
	encodeEnrollmentBundle,
	encodePairingCode,
	type PairingCode,
	randomKeyB64,
} from "./enrollment";

const code: PairingCode = {
	v: 1,
	groupKey: "Z3JvdXA=",
	inviterPub: "aW52aXRlcg==",
	psk: "cHNr",
	relay: "ws://localhost:7400",
};

describe("randomKeyB64", () => {
	it("returns distinct 32-byte base64 keys", () => {
		const a = randomKeyB64();
		const b = randomKeyB64();
		expect(a).not.toBe(b);
		expect(atob(a).length).toBe(32);
	});
});

describe("pairing code", () => {
	it("round-trips", () => {
		expect(decodePairingCode(encodePairingCode(code))).toEqual(code);
	});

	it("is prefixed and tolerates surrounding whitespace", () => {
		const encoded = encodePairingCode(code);
		expect(encoded.startsWith("bramble-pair-1.")).toBe(true);
		expect(decodePairingCode(`  ${encoded}\n`)).toEqual(code);
	});

	it("rejects a wrong prefix", () => {
		expect(() => decodePairingCode("nope.abc")).toThrow();
	});

	it("rejects a malformed body", () => {
		expect(() => decodePairingCode("bramble-pair-1.@@@")).toThrow();
	});

	it("does not carry a VEK field", () => {
		expect(Object.keys(code)).not.toContain("vek");
	});
});

describe("enrollment bundle", () => {
	const bundle: EnrollmentBundle = {
		vek: "dmVr",
		roster: {
			devices: [
				{
					id: "d1",
					publicKey: "pk",
					label: "Laptop",
					addedAt: 1,
					hlc: { wall: 1, counter: 0, node: "d1" },
				},
			],
			revoked: [],
		},
		entries: {
			entries: [
				{
					id: "e1",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: { wall: 2, counter: 0, node: "d1" },
				},
			],
			tombstones: [],
		},
	};

	it("round-trips vek + roster + entries", () => {
		expect(decodeEnrollmentBundle(encodeEnrollmentBundle(bundle))).toEqual(bundle);
	});

	it("rejects a malformed bundle", () => {
		expect(() => decodeEnrollmentBundle(JSON.stringify({ vek: "v" }))).toThrow();
	});
});
