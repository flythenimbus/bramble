import { describe, expect, it } from "vitest";
import { parseBitwarden } from "./bitwarden";

const json = (obj: unknown) => JSON.stringify(obj);

describe("parseBitwarden", () => {
	it("maps each item type and folds identities into notes", () => {
		const res = parseBitwarden(
			json({
				items: [
					{
						type: 1,
						name: "GitHub",
						notes: "n",
						login: {
							uris: [{ uri: "https://github.com" }],
							username: "octo",
							password: "pw",
							totp: "otpauth://t",
						},
						fields: [
							{ name: "PIN", value: "1234", type: 1 }, // hidden
							{ name: "note", value: "hi", type: 0 }, // text
							{ name: "ref", value: "X", type: 3 }, // linked → dropped
						],
					},
					{
						type: 3,
						name: "Visa",
						card: {
							cardholderName: "A B",
							number: "4111111111111111",
							expMonth: "3",
							expYear: "2027",
							code: "123",
						},
					},
					{ type: 2, name: "Secret", notes: "body" },
					{
						type: 5,
						name: "key",
						sshKey: {
							publicKey: "ssh-ed25519 AAAA",
							privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
						},
					},
					{ type: 4, name: "Me", identity: { firstName: "Jane", ssn: "" } },
				],
			}),
		);

		expect(res.byType).toEqual({ login: 1, card: 1, note: 2, "ssh-key": 1 });

		expect(res.imported[0]).toMatchObject({
			type: "login",
			url: "https://github.com",
			username: "octo",
			password: "pw",
			totp: "otpauth://t",
		});
		// linked field dropped; hidden flag preserved.
		expect(res.imported[0]?.customFields).toEqual([
			{ key: "PIN", value: "1234", hidden: true },
			{ key: "note", value: "hi" },
		]);

		expect(res.imported[1]).toMatchObject({
			type: "card",
			cvv: "123",
			brand: "Visa",
			expMonth: "3",
			expYear: "2027",
		});
		expect(res.imported[3]).toMatchObject({ type: "ssh-key", keyType: "ed25519" });
		// identity folded: empty ssn dropped, firstName kept.
		expect(res.imported[4]).toMatchObject({ type: "note", name: "Me" });
		expect(res.imported[4]?.customFields).toEqual([{ key: "firstName", value: "Jane" }]);
	});

	it("tolerates a login with no uris and warns on passkeys", () => {
		const res = parseBitwarden(
			json({
				items: [
					{ type: 1, name: "x", login: { username: "u", password: "p", fido2Credentials: [{}] } },
				],
			}),
		);
		expect(res.imported[0]).toMatchObject({ type: "login", url: "" });
		expect(res.warnings).toHaveLength(1);
	});

	it("rejects non-Bitwarden input", () => {
		expect(() => parseBitwarden("{}")).toThrow();
		expect(() => parseBitwarden("not json")).toThrow();
	});
});
