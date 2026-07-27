import { describe, expect, it } from "vitest";
import type { LoginEntryData } from "../hooks/useVault";
import { parseApplePasswords, parseGooglePasswords } from "./csv";

const APPLE_HEADER = "Title,URL,Username,Password,Notes,OTPAuth";
const GOOGLE_HEADER = "name,url,username,password,note";

const logins = (res: { imported: unknown[] }) => res.imported as LoginEntryData[];

describe("parseApplePasswords", () => {
	it("maps every column, including a full otpauth:// URI", () => {
		const csv = [
			APPLE_HEADER,
			'"GitHub","https://github.com/login","alice@example.com","secret","a note","otpauth://totp/test?secret=ABC"',
		].join("\n");

		const res = parseApplePasswords(csv);

		expect(logins(res)).toEqual([
			{
				type: "login",
				name: "GitHub",
				notes: "a note",
				urls: ["https://github.com/login"],
				username: "alice@example.com",
				password: "secret",
				totp: "otpauth://totp/test?secret=ABC",
			},
		]);
		expect(res.byType).toEqual({ login: 1 });
	});

	it("handles an unset trailing OTPAuth written as a bare comma", () => {
		// Apple's real shape: every field quoted, except an empty last column.
		const csv = [
			APPLE_HEADER,
			'"GitHub","https://github.com/login","alice@example.com","secret","",',
		].join("\n");

		const [entry] = logins(parseApplePasswords(csv));

		expect(entry?.totp).toBeUndefined();
		expect(entry?.password).toBe("secret");
		expect(entry?.notes).toBeUndefined();
	});

	it("keeps notes containing commas and newlines intact", () => {
		const csv = [APPLE_HEADER, '"T","https://x.com","u","p","one, two\nthree",'].join("\n");

		expect(logins(parseApplePasswords(csv))[0]?.notes).toBe("one, two\nthree");
	});

	it("falls back to the URL host when the title is blank", () => {
		const csv = [APPLE_HEADER, '"","https://accounts.google.com/","u","p","",'].join("\n");

		expect(logins(parseApplePasswords(csv))[0]?.name).toBe("accounts.google.com");
	});

	it("rejects a Google export by name instead of failing generically", () => {
		const csv = [GOOGLE_HEADER, "GitHub,https://github.com,alice,pw,"].join("\n");

		expect(() => parseApplePasswords(csv)).toThrow(/Google Password Manager/);
	});

	it("rejects a file that isn't a password CSV at all", () => {
		expect(() => parseApplePasswords("just,some,columns\n1,2,3")).toThrow(/Apple Passwords/);
	});
});

describe("parseGooglePasswords", () => {
	it("maps every column and leaves totp unset (Google exports none)", () => {
		const csv = [GOOGLE_HEADER, "GitHub,https://github.com/login,alice,secret,a note"].join("\n");

		expect(logins(parseGooglePasswords(csv))).toEqual([
			{
				type: "login",
				name: "GitHub",
				notes: "a note",
				urls: ["https://github.com/login"],
				username: "alice",
				password: "secret",
				totp: undefined,
			},
		]);
	});

	it("imports a legacy four-column export with no note column", () => {
		const csv = ["name,url,username,password", "GitHub,https://github.com,alice,secret"].join("\n");

		const [entry] = logins(parseGooglePasswords(csv));

		expect(entry?.username).toBe("alice");
		expect(entry?.notes).toBeUndefined();
	});

	it("rejects an Apple export by name", () => {
		const csv = [APPLE_HEADER, '"T","https://x.com","u","p","",'].join("\n");

		expect(() => parseGooglePasswords(csv)).toThrow(/Apple Passwords/);
	});
});

describe("shared CSV behaviour", () => {
	it("skips rows that carry nothing and counts them as skipped", () => {
		const csv = [GOOGLE_HEADER, "GitHub,https://github.com,alice,secret,", ",,,,"].join("\n");

		const res = parseGooglePasswords(csv);

		expect(res.imported).toHaveLength(1);
		expect(res.skipped).toBe(1);
	});

	it("imports a row with a password but no username", () => {
		const csv = [GOOGLE_HEADER, "Wifi,https://x.com,,secret,"].join("\n");

		const [entry] = logins(parseGooglePasswords(csv));

		expect(entry?.username).toBe("");
		expect(entry?.password).toBe("secret");
	});

	it("is case-insensitive about header casing", () => {
		const csv = ["NAME,URL,Username,PASSWORD,Note", "T,https://x.com,u,p,"].join("\n");

		expect(parseGooglePasswords(csv).imported).toHaveLength(1);
	});

	it("reads a header carrying a UTF-8 BOM", () => {
		const csv = [
			"﻿Title,URL,Username,Password,Notes,OTPAuth",
			'"T","https://x.com","u","p","",',
		].join("\n");

		expect(parseApplePasswords(csv).imported).toHaveLength(1);
	});
});
