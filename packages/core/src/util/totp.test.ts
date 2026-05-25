import * as OTPAuth from "otpauth";
import { describe, expect, it } from "vitest";
import { parseTotp, totpAt } from "./totp";

// RFC 6238 Appendix B uses the ASCII seed "12345678901234567890" (= this base32)
// with SHA-1, 8 digits, a 30s step, and these (time, code) pairs.
const SEED_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_VECTORS: ReadonlyArray<readonly [number, string]> = [
	[59, "94287082"],
	[1111111109, "07081804"],
	[1111111111, "14050471"],
	[1234567890, "89005924"],
	[2000000000, "69279037"],
];

describe("parseTotp", () => {
	it("parses a bare base32 secret with RFC defaults", () => {
		const p = parseTotp(SEED_B32);
		expect(p).not.toBeNull();
		expect(p?.totp.digits).toBe(6);
		expect(p?.totp.period).toBe(30);
	});

	it("tolerates the spaces/dashes sites print setup keys with", () => {
		expect(parseTotp("gezd gnbv gy3t qojq")).not.toBeNull();
		expect(parseTotp("GEZD-GNBV-GY3T-QOJQ")).not.toBeNull();
	});

	it("parses an otpauth:// URI, keeping issuer/account/digits", () => {
		const uri = `otpauth://totp/ACME:alice@acme.com?secret=${SEED_B32}&issuer=ACME&digits=8`;
		const p = parseTotp(uri);
		expect(p?.issuer).toBe("ACME");
		expect(p?.account).toBe("alice@acme.com");
		expect(p?.totp.digits).toBe(8);
	});

	it("rejects empty input, junk, and counter-based HOTP", () => {
		expect(parseTotp("")).toBeNull();
		expect(parseTotp("   ")).toBeNull();
		expect(parseTotp("not a real key!!!")).toBeNull();
		expect(parseTotp(`otpauth://hotp/x?secret=${SEED_B32}&counter=0`)).toBeNull();
	});
});

describe("totpAt", () => {
	it("matches the RFC 6238 reference vectors", () => {
		const totp = new OTPAuth.TOTP({
			secret: OTPAuth.Secret.fromBase32(SEED_B32),
			algorithm: "SHA1",
			digits: 8,
			period: 30,
		});
		for (const [seconds, expected] of RFC_VECTORS) {
			expect(totpAt(totp, seconds * 1000).code).toBe(expected);
		}
	});

	it("reports whole seconds remaining in the current step", () => {
		const p = parseTotp(SEED_B32);
		// 5s into a fresh 30s window leaves 25.
		expect(totpAt(p?.totp as OTPAuth.TOTP, 5_000).secondsRemaining).toBe(25);
		// 30s lands exactly on a boundary -> a full window.
		expect(totpAt(p?.totp as OTPAuth.TOTP, 30_000).secondsRemaining).toBe(30);
	});
});
