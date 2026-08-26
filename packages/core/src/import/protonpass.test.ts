import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseProtonPass } from "./protonpass";

const ppx = (data: unknown): Uint8Array =>
	zipSync({ "Proton Pass/data.json": strToU8(JSON.stringify(data)) });

describe("parseProtonPass", () => {
	it("maps logins/cards/notes, keeps a distinct email, and skips trashed items", () => {
		const res = parseProtonPass(
			ppx({
				vaults: {
					v1: {
						name: "Personal",
						items: [
							{
								state: 1,
								data: {
									type: "login",
									metadata: { name: "GitHub", note: "n" },
									content: {
										itemEmail: "a@b.com",
										itemUsername: "octo",
										password: "pw",
										urls: ["https://github.com"],
										totpUri: "otpauth://t",
									},
									extraFields: [{ fieldName: "Recovery", type: "hidden", data: { content: "R" } }],
								},
							},
							{
								state: 1,
								data: {
									type: "creditCard",
									metadata: { name: "Visa" },
									content: {
										cardholderName: "A B",
										number: "4111111111111111",
										verificationNumber: "123",
										expirationDate: "032027",
										pin: "0000",
									},
								},
							},
							{ state: 2, data: { type: "login", metadata: { name: "trashed" }, content: {} } },
							{ state: 1, data: { type: "note", metadata: { name: "Note", note: "body" } } },
						],
					},
				},
			}),
		);

		// trashed item excluded.
		expect(res.imported).toHaveLength(3);
		expect(res.byType).toEqual({ login: 1, card: 1, note: 1 });

		expect(res.imported[0]).toMatchObject({
			type: "login",
			username: "octo",
			password: "pw",
			urls: ["https://github.com"],
			totp: "otpauth://t",
		});
		// distinct email retained; hidden extra field preserved.
		expect(res.imported[0]?.customFields).toEqual([
			{ key: "email", value: "a@b.com" },
			{ key: "Recovery", value: "R", hidden: true },
		]);

		expect(res.imported[1]).toMatchObject({
			type: "card",
			cvv: "123",
			expMonth: "3",
			expYear: "2027",
			brand: "Visa",
		});
		// PIN has no card slot → kept as a hidden custom field.
		expect(res.imported[1]?.customFields).toEqual([{ key: "PIN", value: "0000", hidden: true }]);
	});

	it("handles YYYY-MM expiry too", () => {
		const res = parseProtonPass(
			ppx({
				vaults: {
					v1: {
						items: [
							{
								state: 1,
								data: {
									type: "creditCard",
									metadata: { name: "C" },
									content: { number: "4111", expirationDate: "2027-03" },
								},
							},
						],
					},
				},
			}),
		);
		expect(res.imported[0]).toMatchObject({ expMonth: "3", expYear: "2027" });
	});
});

describe("parseProtonPass tags", () => {
	// Proton organises by vault, which is the closest thing its export has to a tag.
	it("tags each item with the vault it came from", () => {
		const res = parseProtonPass(
			ppx({
				vaults: {
					v1: {
						name: "Work",
						items: [{ state: 1, data: { type: "login", metadata: { name: "Jira" }, content: {} } }],
					},
				},
			}),
		);
		expect(res.imported[0]?.tags).toEqual(["Work"]);
	});

	it("leaves tags off when the vault is unnamed", () => {
		const res = parseProtonPass(
			ppx({
				vaults: {
					v1: {
						items: [{ state: 1, data: { type: "login", metadata: { name: "Jira" }, content: {} } }],
					},
				},
			}),
		);
		expect(res.imported[0]?.tags).toBeUndefined();
	});
});
