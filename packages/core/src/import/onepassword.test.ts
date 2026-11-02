import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseOnePassword } from "./onepassword";
import type { ImportAttachment } from "./types";

const pux = (data: unknown, files: Record<string, string> = {}): Uint8Array =>
	zipSync({
		"export.data": strToU8(JSON.stringify(data)),
		...Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
	});

const items = (...is: unknown[]) => ({ accounts: [{ vaults: [{ items: is }] }] });

describe("parseOnePassword", () => {
	it("maps login (loginFields + section TOTP), card (YYYYMM expiry), 005 password, and notes", () => {
		const res = parseOnePassword(
			pux(
				items(
					{
						categoryUuid: "001",
						overview: { title: "GitHub", url: "https://github.com" },
						details: {
							loginFields: [
								{ designation: "username", value: "octo" },
								{ designation: "password", value: "pw" },
							],
							sections: [
								{
									fields: [
										{ id: "otp", title: "one-time password", value: { totp: "otpauth://t" } },
										{ id: "x", title: "Extra", value: { string: "v" } },
										{ id: "s", title: "Secret", value: { concealed: "sec" } },
									],
								},
							],
							notesPlain: "hi",
						},
					},
					{
						categoryUuid: "002",
						overview: { title: "Visa" },
						details: {
							sections: [
								{
									fields: [
										{ id: "cardholder", title: "cardholder name", value: { string: "A B" } },
										{
											id: "ccnum",
											title: "number",
											value: { creditCardNumber: "4111111111111111" },
										},
										{ id: "cvv", title: "verification number", value: { concealed: "123" } },
										{ id: "expiry", title: "expiry date", value: { monthYear: 202703 } },
									],
								},
							],
						},
					},
					{ categoryUuid: "005", overview: { title: "WiFi" }, details: { password: "secretpw" } },
					{ categoryUuid: "003", overview: { title: "Note" }, details: { notesPlain: "text" } },
				),
			),
		);

		expect(res.byType).toEqual({ login: 2, card: 1, note: 1 });

		expect(res.imported[0]).toMatchObject({
			type: "login",
			urls: ["https://github.com"],
			username: "octo",
			password: "pw",
			totp: "otpauth://t",
			notes: "hi",
		});
		// the TOTP section field is consumed into `totp`, not duplicated as custom.
		expect(res.imported[0]?.customFields).toEqual([
			{ key: "Extra", value: "v" },
			{ key: "Secret", value: "sec", hidden: true },
		]);

		expect(res.imported[1]).toMatchObject({
			type: "card",
			cardholderName: "A B",
			number: "4111111111111111",
			cvv: "123",
			expMonth: "3",
			expYear: "2027",
			brand: "Visa",
		});

		// 005 (password-only) → login with empty username.
		expect(res.imported[2]).toMatchObject({ type: "login", username: "", password: "secretpw" });
		expect(res.imported[3]).toMatchObject({ type: "note", name: "Note" });
	});

	it("rejects a zip without export.data", () => {
		const bad = zipSync({ "other.txt": strToU8("nope") });
		expect(() => parseOnePassword(bad)).toThrow();
	});
});

describe("parseOnePassword tags", () => {
	// 1Password's tags are the feature this whole thing mirrors, so they map straight over.
	it("carries an item's tags across", () => {
		const res = parseOnePassword(
			pux(
				items({
					categoryUuid: "001",
					overview: { title: "GitHub", tags: ["work", "dev"] },
					details: { loginFields: [{ designation: "username", value: "octo" }] },
				}),
			),
		);
		expect(res.imported[0]?.tags).toEqual(["work", "dev"]);
	});

	// Tags are per-item, not per-category: a note must get them as readily as a login.
	it("applies them whatever the item category maps to", () => {
		const res = parseOnePassword(
			pux(
				items({
					categoryUuid: "003",
					overview: { title: "Note", tags: ["archive-me"] },
					details: { notesPlain: "n" },
				}),
			),
		);
		expect(res.imported[0]?.type).toBe("note");
		expect(res.imported[0]?.tags).toEqual(["archive-me"]);
	});

	it("leaves tags off an untagged item", () => {
		const res = parseOnePassword(
			pux(items({ categoryUuid: "003", overview: { title: "Note" }, details: {} })),
		);
		expect(res.imported[0]?.tags).toBeUndefined();
	});
});

describe("parseOnePassword files", () => {
	// files/ holds every file, named by the documentId export.data refers to it by.
	const fileField = (documentId: string, fileName: string) => ({
		id: documentId,
		title: fileName,
		value: { file: { fileName, documentId, decryptedSize: 1 } },
	});
	const text = async (a: ImportAttachment | undefined) =>
		a?.source.kind === "blob" ? await a.source.blob.text() : undefined;

	it("carries a field's file and a Document's file onto their items", async () => {
		const res = parseOnePassword(
			pux(
				items(
					{
						categoryUuid: "001",
						overview: { title: "Bank" },
						details: {
							loginFields: [{ designation: "username", value: "me" }],
							sections: [{ fields: [fileField("aaaa", "statement.pdf")] }],
						},
					},
					{
						categoryUuid: "006",
						// Tagged, so the file has to follow the tagged copy of the entry.
						overview: { title: "Passport", tags: ["id"] },
						details: {
							notesPlain: "renew 2030",
							documentAttributes: { fileName: "scan.png", documentId: "bbbb", decryptedSize: 3 },
						},
					},
				),
				{ "files/aaaa__statement.pdf": "pdf bytes", "files/bbbb__scan.png": "png" },
			),
		);
		const [bank, passport] = res.imported;
		expect(passport).toMatchObject({ type: "note", name: "Passport", notes: "renew 2030" });
		expect(res.attachments?.map((a) => [a.entry, a.name, a.mime, a.size])).toEqual([
			[bank, "statement.pdf", "application/pdf", 9],
			[passport, "scan.png", "image/png", 3],
		]);
		expect(await text(res.attachments?.[0])).toBe("pdf bytes");
		expect(await text(res.attachments?.[1])).toBe("png");
		// A file field is the file itself, not a blank custom field beside it.
		expect(bank?.customFields).toBeUndefined();
		expect(res.warnings).toEqual([]);
	});

	// 1Password's format page writes the separator as three underscores; real exports, as
	// KeePassXC and Proton Pass read them, use two. The documentId is what identifies the file.
	it("finds a file however many underscores follow its documentId", async () => {
		const res = parseOnePassword(
			pux(
				items({
					categoryUuid: "003",
					overview: { title: "Note" },
					details: { sections: [{ fields: [fileField("cccc", "a_b.txt")] }] },
				}),
				{ "files/cccc___a_b.txt": "three" },
			),
		);
		expect(res.attachments?.map((a) => a.name)).toEqual(["a_b.txt"]);
		expect(await text(res.attachments?.[0])).toBe("three");
	});

	it("says so when an item names a file the export does not hold", () => {
		const res = parseOnePassword(
			pux(
				items({
					categoryUuid: "003",
					overview: { title: "Note" },
					details: { sections: [{ fields: [fileField("dddd", "gone.pdf")] }] },
				}),
			),
		);
		expect(res.imported).toHaveLength(1);
		expect(res.attachments).toBeUndefined();
		expect(res.warnings).toEqual([
			"1 attachment(s) are named in this export but not stored in it.",
		]);
	});

	// files/ also carries custom item icons, which no field names. Those aren't the user's files.
	it("brings only the files an item names", () => {
		const res = parseOnePassword(
			pux(
				items({
					categoryUuid: "003",
					overview: { title: "Note" },
					details: { sections: [{ fields: [fileField("eeee", "kept.txt")] }] },
				}),
				{ "files/eeee__kept.txt": "kept", "files/ffff__icon.png": "icon" },
			),
		);
		expect(res.attachments?.map((a) => a.name)).toEqual(["kept.txt"]);
	});
});
