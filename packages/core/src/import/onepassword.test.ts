import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseOnePassword } from "./onepassword";

const pux = (data: unknown): Uint8Array =>
	zipSync({ "export.data": strToU8(JSON.stringify(data)) });

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
