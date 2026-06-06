import { describe, expect, it } from "vitest";
import type { KdbxRawEntry } from "../adapters/crypto";
import { kdbxEntriesToResult } from "./kdbx";

// The WASM open already decrypts protected values and drops History / Recycle
// Bin entries, so these tests cover only the JS mapping of the raw String pairs
// it hands back (which reuses keepass.ts mapKeepassFields).
const entry = (strings: KdbxRawEntry["strings"]): KdbxRawEntry => ({ strings });

describe("kdbxEntriesToResult", () => {
	it("maps raw KeePass strings to logins, with protected → hidden custom field", () => {
		const res = kdbxEntriesToResult([
			entry([
				{ key: "Title", value: "GitHub", protected: false },
				{ key: "UserName", value: "octo", protected: false },
				{ key: "Password", value: "pw", protected: true },
				{ key: "URL", value: "https://github.com", protected: false },
				{ key: "Notes", value: "note", protected: false },
				{ key: "otp", value: "otpauth://t", protected: true },
				{ key: "API Key", value: "secret", protected: true },
				{ key: "Visible Field", value: "shown", protected: false },
			]),
		]);

		expect(res.imported).toHaveLength(1);
		expect(res.byType).toEqual({ login: 1 });
		expect(res.imported[0]).toMatchObject({
			type: "login",
			name: "GitHub",
			username: "octo",
			password: "pw",
			urls: ["https://github.com"],
			notes: "note",
			totp: "otpauth://t",
		});
		// Protected custom field stays hidden; plain one doesn't.
		expect(res.imported[0]?.customFields).toEqual([
			{ key: "API Key", value: "secret", hidden: true },
			{ key: "Visible Field", value: "shown" },
		]);
	});

	it("wraps an empty URL to an empty list", () => {
		const res = kdbxEntriesToResult([
			entry([{ key: "Title", value: "No site", protected: false }]),
		]);
		expect(res.imported[0]).toMatchObject({ name: "No site", urls: [] });
	});

	it("returns nothing for an empty database", () => {
		const res = kdbxEntriesToResult([]);
		expect(res.imported).toHaveLength(0);
		expect(res.byType).toEqual({});
	});
});
