import { describe, expect, it } from "vitest";
import type { KdbxRawEntry } from "../adapters/crypto";
import { kdbxEntriesToResult } from "./kdbx";

/** No KeePass fixture here carries a passkey, so reaching the crypto bridge is itself a bug. */
const noPasskeys = {
	passkeyImportPkcs8: () => Promise.reject(new Error("no passkey expected in this test")),
};

// The WASM open already decrypts protected values and drops History / Recycle
// Bin entries, so these tests cover only the JS mapping of the raw String pairs
// it hands back (which reuses keepass.ts mapKeepassFields).
const entry = (strings: KdbxRawEntry["strings"]): KdbxRawEntry => ({ strings });
const opened = (entries: KdbxRawEntry[]) => ({ entries, attachments: [] });

describe("kdbxEntriesToResult", () => {
	it("maps raw KeePass strings to logins, with protected → hidden custom field", async () => {
		const res = await kdbxEntriesToResult(
			opened([
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
			]),
			noPasskeys,
		);

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

	it("wraps an empty URL to an empty list", async () => {
		const res = await kdbxEntriesToResult(
			opened([entry([{ key: "Title", value: "No site", protected: false }])]),
			noPasskeys,
		);
		expect(res.imported[0]).toMatchObject({ name: "No site", urls: [] });
	});

	it("matches a login on a port exactly (#145)", async () => {
		const res = await kdbxEntriesToResult(
			opened([entry([{ key: "URL", value: "https://10.0.0.2:8443", protected: false }])]),
			noPasskeys,
		);
		expect(res.imported[0]).toMatchObject({ subdomainMatch: "exact" });
	});

	it("returns nothing for an empty database", async () => {
		const res = await kdbxEntriesToResult(opened([]), noPasskeys);
		expect(res.imported).toHaveLength(0);
		expect(res.byType).toEqual({});
	});
});

describe("kdbxEntriesToResult: attachments", () => {
	const blob = (text: string) => ({
		source: { kind: "blob" as const, blob: new Blob([text]) },
		size: text.length,
	});

	it("carries each attachment on its entry, by name, with a type from the name", async () => {
		const res = await kdbxEntriesToResult(
			{
				entries: [
					{
						strings: [{ key: "Title", value: "Passport", protected: false }],
						binaries: [
							{ name: "scan.pdf", index: 0 },
							{ name: "note.txt", index: 1 },
						],
					},
					// KeePass stores one copy of shared content; both entries get a file of their own.
					{
						strings: [{ key: "Title", value: "Deed", protected: false }],
						binaries: [{ name: "copy.txt", index: 1 }],
					},
				],
				attachments: [blob("pdf bytes"), blob("note")],
			},
			noPasskeys,
		);
		const [passport, deed] = res.imported;
		expect(res.attachments?.map((a) => [a.entry, a.name, a.mime, a.size])).toEqual([
			[passport, "scan.pdf", "application/pdf", 9],
			[passport, "note.txt", "text/plain", 4],
			[deed, "copy.txt", "text/plain", 4],
		]);
		expect(res.warnings).toEqual([]);
	});

	it("says so when an entry names an attachment the database does not hold", async () => {
		const res = await kdbxEntriesToResult(
			{
				entries: [
					{
						strings: [{ key: "Title", value: "T", protected: false }],
						binaries: [{ name: "gone.pdf", index: 3 }],
					},
				],
				attachments: [],
			},
			noPasskeys,
		);
		expect(res.attachments).toBeUndefined();
		expect(res.warnings.some((w) => w.includes("named in this database but not stored"))).toBe(
			true,
		);
	});
});
