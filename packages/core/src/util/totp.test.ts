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
		expect(parseTotp("otpauth://totp/x?issuer=ACME")).toBeNull();
		expect(parseTotp(`otpauth://totp/x?secret=${SEED_B32}&algorithm=MD5`)).toBeNull();
	});

	// #204: URIs other apps export, and Android/iOS autofill already read, that the strict
	// key-URI grammar refuses.
	it.each([
		["an empty label", `otpauth://totp/?secret=${SEED_B32}&issuer=ACME`],
		["no label at all", `otpauth://totp?secret=${SEED_B32}`],
		["a spaced secret", `otpauth://totp/ACME:alice?secret=GEZD%20GNBV%20GY3T%20QOJQ`],
		["a fractional period", `otpauth://totp/ACME:alice?secret=${SEED_B32}&period=30.000000`],
		["a stray % in the label", `otpauth://totp/100%:alice?secret=${SEED_B32}`],
		[
			"a ? inside a value",
			`otpauth://totp/ACME:alice?secret=${SEED_B32}&image=https://x.test/i.png?s=1`,
		],
		["a dashed algorithm", `otpauth://totp/ACME:alice?secret=${SEED_B32}&algorithm=SHA-256`],
	])("accepts a URI with %s", (_, uri) => {
		expect(parseTotp(uri)).not.toBeNull();
	});

	it("keeps issuer, account and parameters from a URI only the loose path reads", () => {
		const p = parseTotp(
			`otpauth://totp/ACME:alice?secret=${SEED_B32}&period=60.0&digits=8&algorithm=sha-256&issuer=ACME`,
		);
		expect(p?.issuer).toBe("ACME");
		expect(p?.account).toBe("alice");
		expect(p?.totp.period).toBe(60);
		expect(p?.totp.digits).toBe(8);
		expect(p?.totp.algorithm).toBe("SHA256");
	});

	it("generates the same code from a loose URI as from its bare secret", () => {
		const loose = parseTotp(`otpauth://totp/?secret=${SEED_B32}`);
		const bare = parseTotp(SEED_B32);
		expect(loose && totpAt(loose.totp, 59_000).code).toBe(bare && totpAt(bare.totp, 59_000).code);
	});
});

describe("Steam Guard keys (#55)", () => {
	// Reference codes from an independent HMAC-SHA1 implementation of Steam's 5-character code.
	const STEAM_VECTORS: ReadonlyArray<readonly [number, string]> = [
		[59, "PV9M4"],
		[1111111109, "PY4YB"],
		[1234567890, "VHHQY"],
		[2000000000, "9N776"],
	];

	it.each([
		["steam:// (Bitwarden)", `steam://${SEED_B32}`],
		["otpauth://steam/ (Aegis)", `otpauth://steam/Steam:alice?secret=${SEED_B32}&issuer=Steam`],
		["encoder=steam (KeePassXC)", `otpauth://totp/Steam:alice?secret=${SEED_B32}&encoder=steam`],
	])("reads %s", (_, key) => {
		const p = parseTotp(key);
		expect(p?.steam).toBe(true);
		for (const [seconds, expected] of STEAM_VECTORS) {
			expect(p && totpAt(p.totp, seconds * 1000).code).toBe(expected);
		}
	});

	it("keeps the account from a Steam URI", () => {
		const p = parseTotp(`otpauth://steam/Steam:alice?secret=${SEED_B32}&issuer=Steam`);
		expect(p?.issuer).toBe("Steam");
		expect(p?.account).toBe("alice");
	});

	it("leaves an ordinary key alone", () => {
		expect(parseTotp(SEED_B32)?.steam).toBe(false);
		expect(parseTotp(`otpauth://totp/Steam:alice?secret=${SEED_B32}&issuer=Steam`)?.steam).toBe(
			false,
		);
	});

	it("rejects a steam:// key with no valid secret", () => {
		expect(parseTotp("steam://")).toBeNull();
		expect(parseTotp("steam://not!base32")).toBeNull();
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
