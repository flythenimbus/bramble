import { describe, expect, it } from "vitest";
import {
	decodeEnrollmentBundle,
	decodePairingCode,
	type EnrollmentBundle,
	encodeEnrollmentBundle,
	encodePairingCode,
	INVITE_TTL_MS,
	type PairingCode,
	pairingCodeExpired,
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

// The invite window (GHSA-x4f5-4wq4-c6c8). `exp` is additive: it must not break a code produced
// by, or handed to, a build that predates it — hence no `v` bump and no prefix change.
describe("pairing code expiry", () => {
	const NOW = 1_800_000_000_000;
	const live: PairingCode = { ...code, exp: NOW + INVITE_TTL_MS };

	it("round-trips exp", () => {
		expect(decodePairingCode(encodePairingCode(live))).toEqual(live);
	});

	it("still parses a code with no exp (an older inviter)", () => {
		const parsed = decodePairingCode(encodePairingCode(code));
		expect(parsed.exp).toBeUndefined();
		expect(pairingCodeExpired(parsed, NOW)).toBe(false); // nothing to enforce; never expires here
	});

	it("tolerates unknown future fields rather than throwing", () => {
		// zod strips unknown keys, which is what lets a NEWER code be read by an older build. If
		// this ever became strict, every future additive field would be a hard compat break.
		const forward = JSON.stringify({ ...live, somethingNew: "x", nested: { a: 1 } });
		const encoded = `bramble-pair-1.${btoa(forward)}`;
		expect(decodePairingCode(encoded)).toEqual(live);
	});

	it("is live inside the window and expired past it", () => {
		expect(pairingCodeExpired(live, NOW)).toBe(false);
		expect(pairingCodeExpired(live, NOW + INVITE_TTL_MS - 1)).toBe(false);
		expect(pairingCodeExpired(live, NOW + INVITE_TTL_MS + 10 * 60_000)).toBe(true);
	});

	it("gives a joiner whose clock runs fast a grace period", () => {
		// The inviter's LOCAL timer is the enforcement; this check only picks the error message, so
		// it must not refuse a code the inviter is still honouring just because clocks disagree.
		const justPast = NOW + INVITE_TTL_MS + 1_000;
		expect(pairingCodeExpired(live, justPast)).toBe(false);
		expect(pairingCodeExpired(live, justPast, 0)).toBe(true); // ...but the window itself is real
	});

	it("rejects a non-positive or fractional exp", () => {
		expect(() =>
			decodePairingCode(`bramble-pair-1.${btoa(JSON.stringify({ ...code, exp: -1 }))}`),
		).toThrow();
		expect(() =>
			decodePairingCode(`bramble-pair-1.${btoa(JSON.stringify({ ...code, exp: 1.5 }))}`),
		).toThrow();
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
