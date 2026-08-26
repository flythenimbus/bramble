import { describe, expect, it, vi } from "vitest";
import { parseBitwarden } from "./bitwarden";

const json = (obj: unknown) => JSON.stringify(obj);
// Synthetic P-256 PKCS#8 vector using Bitwarden's exported key encoding.
const BITWARDEN_TEST_PKCS8_B64URL =
	"MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgBnZeheB_70OqF-B614VjAYBwjGxhQ33Dseb5CSTrH_WhRANCAAQ1mlLzgkRmXz_ixAscFjTFYAc6Jf5-f3_a1Bw2kADusY6Ss6yRf7GMpIXnAwfR9VvTe8NWEd-8epdwMks8hAVx";
const BITWARDEN_TEST_PKCS8_B64 =
	"MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgBnZeheB/70OqF+B614VjAYBwjGxhQ33Dseb5CSTrH/WhRANCAAQ1mlLzgkRmXz/ixAscFjTFYAc6Jf5+f3/a1Bw2kADusY6Ss6yRf7GMpIXnAwfR9VvTe8NWEd+8epdwMks8hAVx";

function importContext(
	convert: (pkcs8StandardB64: string) => Promise<{
		privateKey: string;
		publicKeyCose: string;
	}> = async () => ({ privateKey: "c2NhbGFy", publicKeyCose: "Y29zZQ==" }),
) {
	const passkeyImportPkcs8 = vi.fn(convert);
	return { context: { passkeyImportPkcs8 }, passkeyImportPkcs8 };
}

function validPasskey(over: Record<string, unknown> = {}) {
	return {
		credentialId: "00112233-4455-6677-8899-aabbccddeeff",
		keyType: "public-key",
		keyAlgorithm: "ECDSA",
		keyCurve: "P-256",
		keyValue: BITWARDEN_TEST_PKCS8_B64URL,
		rpId: "github.com",
		rpName: "GitHub",
		userHandle: "dXNlci1vbmU",
		userName: "octo",
		userDisplayName: "Octo Cat",
		counter: "0",
		creationDate: "2024-02-03T04:05:06.000Z",
		discoverable: "true",
		...over,
	};
}

describe("parseBitwarden", () => {
	it("maps each item type and folds identities into notes", async () => {
		const { context } = importContext();
		const res = await parseBitwarden(
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
			context,
		);

		expect(res.byType).toEqual({ login: 1, card: 1, note: 2, "ssh-key": 1 });

		expect(res.imported[0]).toMatchObject({
			type: "login",
			urls: ["https://github.com"],
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

	it("maps per-URI match detection onto the entry's subdomainMatch", async () => {
		const { context } = importContext();
		const res = await parseBitwarden(
			json({
				items: [
					// Default (base domain) / null: stays eTLD+1, so no explicit subdomainMatch.
					{
						type: 1,
						name: "domain-default",
						login: { uris: [{ uri: "https://a.com", match: 0 }] },
					},
					{ type: 1, name: "null-match", login: { uris: [{ uri: "https://b.com", match: null }] } },
					{ type: 1, name: "no-match-field", login: { uris: [{ uri: "https://c.com" }] } },
					// Host (1): the reported case — tighten to exact.
					{ type: 1, name: "host", login: { uris: [{ uri: "https://accounts.d.com", match: 1 }] } },
					{ type: 1, name: "exact", login: { uris: [{ uri: "https://e.com", match: 3 }] } },
					// Mixed: any non-default URI tightens the whole entry.
					{
						type: 1,
						name: "mixed",
						login: {
							uris: [
								{ uri: "https://f.com", match: 0 },
								{ uri: "https://g.f.com", match: 1 },
							],
						},
					},
				],
			}),
			context,
		);
		const bySubMatch = Object.fromEntries(
			res.imported.map((e) => [e.name, (e as { subdomainMatch?: string }).subdomainMatch]),
		);
		expect(bySubMatch).toEqual({
			"domain-default": undefined,
			"null-match": undefined,
			"no-match-field": undefined,
			host: "exact",
			exact: "exact",
			mixed: "exact",
		});
	});

	it("imports multiple passkeys and preserves the parent login fields", async () => {
		const { context, passkeyImportPkcs8 } = importContext();
		const res = await parseBitwarden(
			json({
				items: [
					{
						type: 1,
						name: "GitHub",
						notes: "keep",
						creationDate: "2023-01-02T03:04:05.000Z",
						login: {
							uris: [{ uri: "https://github.com" }],
							username: "octo",
							password: "pw",
							totp: "otpauth://totp/example",
							fido2Credentials: [
								validPasskey(),
								validPasskey({
									credentialId: "b64._-4",
									keyValue: "BQY",
									userHandle: "dXNlci10d28",
									userName: null,
									userDisplayName: null,
									discoverable: "false",
								}),
							],
						},
						fields: [{ name: "PIN", value: "1234", type: 1 }],
					},
				],
			}),
			context,
		);

		expect(res.skipped).toBe(0);
		expect(res.warnings).toEqual([]);
		expect(res.imported).toHaveLength(1);
		expect(res.imported[0]).toMatchObject({
			type: "login",
			name: "GitHub",
			notes: "keep",
			urls: ["https://github.com"],
			username: "octo",
			password: "pw",
			totp: "otpauth://totp/example",
			createdAt: Date.parse("2023-01-02T03:04:05.000Z"),
			customFields: [{ key: "PIN", value: "1234", hidden: true }],
			passkeys: [
				{
					credentialId: "ABEiM0RVZneImaq7zN3u/w==",
					rpId: "github.com",
					rpName: "GitHub",
					userHandle: "dXNlci1vbmU=",
					userName: "octo",
					userDisplayName: "Octo Cat",
					alg: -7,
					publicKeyCose: "Y29zZQ==",
					privateKey: "c2NhbGFy",
					signCount: 0,
					createdAt: Date.parse("2024-02-03T04:05:06.000Z"),
				},
				{
					credentialId: "/+4=",
					userHandle: "dXNlci10d28=",
				},
			],
		});
		expect(passkeyImportPkcs8.mock.calls).toEqual([[BITWARDEN_TEST_PKCS8_B64], ["BQY="]]);
	});

	it("ignores Bitwarden's discoverability hint and imports every otherwise valid credential", async () => {
		const { context } = importContext();
		const res = await parseBitwarden(
			json({
				items: [
					{
						type: 1,
						name: "portable",
						login: {
							fido2Credentials: [
								validPasskey({ credentialId: "b64.AQ", discoverable: "true" }),
								validPasskey({ credentialId: "b64.Ag", discoverable: "false" }),
								validPasskey({ credentialId: "b64.Aw", discoverable: false }),
								validPasskey({ credentialId: "b64.BA", discoverable: { malformed: true } }),
								validPasskey({ credentialId: "b64.BQ", discoverable: undefined }),
							],
						},
					},
				],
			}),
			context,
		);

		expect(res.warnings).toEqual([]);
		expect(res.imported[0]).toMatchObject({
			type: "login",
			passkeys: [
				{ credentialId: "AQ==" },
				{ credentialId: "Ag==" },
				{ credentialId: "Aw==" },
				{ credentialId: "BA==" },
				{ credentialId: "BQ==" },
			],
		});
	});

	it("skips malformed and unsupported passkeys without dropping the login or valid siblings", async () => {
		const { context } = importContext(async (pkcs8) => {
			if (pkcs8 === "cmVqZWN0") throw new Error("synthetic conversion failure");
			return { privateKey: "c2NhbGFy", publicKeyCose: "Y29zZQ==" };
		});
		const res = await parseBitwarden(
			json({
				items: [
					{
						type: 1,
						name: "mixed",
						login: {
							username: "u",
							password: "p",
							fido2Credentials: [
								validPasskey(),
								{},
								validPasskey({ keyCurve: "P-384" }),
								validPasskey({ userHandle: "" }),
								validPasskey({ credentialId: "not-a-supported-id" }),
								validPasskey({ keyValue: "cmVqZWN0" }),
							],
						},
					},
				],
			}),
			context,
		);

		expect(res.skipped).toBe(0);
		expect(res.imported[0]).toMatchObject({
			type: "login",
			username: "u",
			password: "p",
			urls: [],
			passkeys: [{ credentialId: "ABEiM0RVZneImaq7zN3u/w==" }],
		});
		expect(res.warnings).toHaveLength(5);
		expect(res.warnings.join("\n")).toMatch(/unexpected shape/);
		expect(res.warnings.join("\n")).toMatch(/unsupported key type, algorithm, or curve/);
		expect(res.warnings.join("\n")).toMatch(/credential ID that is/);
		expect(res.warnings.join("\n")).toMatch(/invalid private-key material/);
		expect(res.warnings.join("\n")).not.toContain("cmVqZWN0");
	});

	it("rejects oversized encoded credential IDs and user handles before conversion", async () => {
		const { context, passkeyImportPkcs8 } = importContext();
		const res = await parseBitwarden(
			json({
				items: [
					{
						type: 1,
						name: "bounded",
						login: {
							username: "keep",
							password: "parent",
							fido2Credentials: [
								validPasskey({ credentialId: `b64.${"A".repeat(1365)}` }),
								validPasskey({ userHandle: "A".repeat(1365) }),
							],
						},
					},
				],
			}),
			context,
		);

		expect(passkeyImportPkcs8).not.toHaveBeenCalled();
		expect(res.skipped).toBe(0);
		expect(res.imported[0]).toMatchObject({
			type: "login",
			username: "keep",
			password: "parent",
		});
		const login = res.imported[0];
		if (login?.type !== "login") throw new Error("expected retained login");
		expect(login.passkeys).toBeUndefined();
		expect(res.warnings).toHaveLength(2);
	});

	// PayPal issues a user.id past WebAuthn's 64-byte ceiling, and a provider that intercepts
	// create() never applies the browser's TypeError. github issue #40.
	it("imports a user handle that exceeds WebAuthn's 64-byte cap", async () => {
		const { context } = importContext();
		const res = await parseBitwarden(
			json({
				items: [
					{
						type: 1,
						name: "www.paypal.com",
						login: { fido2Credentials: [validPasskey({ userHandle: "A".repeat(87) })] },
					},
				],
			}),
			context,
		);

		expect(res.warnings).toEqual([]);
		expect(res.imported[0]).toMatchObject({
			type: "login",
			// 87 base64url chars decode to 65 bytes, one past the spec ceiling.
			passkeys: [{ userHandle: `${"A".repeat(87)}=` }],
		});
	});

	it("rejects oversized PKCS#8 before conversion and retains the parent login", async () => {
		const { context, passkeyImportPkcs8 } = importContext();
		const res = await parseBitwarden(
			json({
				items: [
					{
						type: 1,
						name: "oversized key",
						login: {
							username: "keep",
							password: "parent",
							// 1,367 base64url chars is larger than the 1 KiB decoded-key ceiling.
							fido2Credentials: [validPasskey({ keyValue: "A".repeat(1367) })],
						},
					},
				],
			}),
			context,
		);

		expect(passkeyImportPkcs8).not.toHaveBeenCalled();
		expect(res.skipped).toBe(0);
		expect(res.imported[0]).toMatchObject({
			type: "login",
			username: "keep",
			password: "parent",
		});
		const login = res.imported[0];
		if (login?.type !== "login") throw new Error("expected retained login");
		expect(login.passkeys).toBeUndefined();
		expect(res.warnings).toEqual([
			'"oversized key" passkey 1 has a private key that is longer than the 1024-byte maximum, so it was skipped.',
		]);
	});

	it("normalizes counters and falls back to the parent creation date", async () => {
		const { context } = importContext();
		const parentDate = "2022-06-07T08:09:10.000Z";
		const res = await parseBitwarden(
			json({
				items: [
					{
						type: 1,
						name: "dated",
						creationDate: parentDate,
						login: {
							fido2Credentials: [validPasskey({ counter: "12", creationDate: "not a date" })],
						},
					},
				],
			}),
			context,
		);

		expect(res.imported[0]).toMatchObject({
			type: "login",
			passkeys: [{ signCount: 0, createdAt: Date.parse(parentDate) }],
		});
		expect(res.warnings).toEqual([
			'"dated" passkey 1 had its signature counter reset to zero.',
			'"dated" passkey 1 had no valid creation date; a fallback date was used.',
		]);
	});

	it("uses one import timestamp when neither credential nor parent has a valid date", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_725_000_000_000);
		const { context } = importContext();
		try {
			const res = await parseBitwarden(
				json({
					items: [
						{
							type: 1,
							name: "fallback",
							login: {
								fido2Credentials: [
									validPasskey({ creationDate: null }),
									validPasskey({ creationDate: undefined }),
								],
							},
						},
					],
				}),
				context,
			);
			expect(res.imported[0]).toMatchObject({
				type: "login",
				passkeys: [{ createdAt: 1_725_000_000_000 }, { createdAt: 1_725_000_000_000 }],
			});
		} finally {
			now.mockRestore();
		}
	});

	it("rejects non-Bitwarden input", async () => {
		const { context } = importContext();
		await expect(parseBitwarden("{}", context)).rejects.toThrow();
		await expect(parseBitwarden("not json", context)).rejects.toThrow();
	});

	it("gives a specific error for an encrypted (password-protected) export", async () => {
		const { context } = importContext();
		// The password-protected format: no `items`, an opaque `data` blob, `encrypted: true`.
		const enc = json({ encrypted: true, passwordProtected: true, salt: "x", data: "2.abc|def" });
		await expect(parseBitwarden(enc, context)).rejects.toThrow(/encrypted \(password-protected\)/i);
		// passwordProtected alone (some exports omit `encrypted`) is caught too.
		await expect(
			parseBitwarden(json({ passwordProtected: true, data: "x" }), context),
		).rejects.toThrow(/encrypted/i);
	});

	it("does not misfire on an unencrypted export (encrypted: false)", async () => {
		const { context } = importContext();
		const res = await parseBitwarden(
			json({ encrypted: false, items: [{ type: 2, name: "n" }] }),
			context,
		);
		expect(res.imported).toHaveLength(1);
	});
});

describe("parseBitwarden archived items", () => {
	// Real exports carry `archivedDate`; Bitwarden's published import schema does not
	// document it. Shape taken from an actual export.
	const archivedItem = {
		type: 1,
		name: "accounts.firefox.com",
		favorite: false,
		reprompt: 0,
		id: "83551d8a-858b-4546-8466-b47900fc74d9",
		collectionIds: null,
		notes: "n",
		fields: [],
		login: { uris: [{ uri: "https://accounts.firefox.com" }], password: "", totp: "otpauth://t" },
		passwordHistory: [],
		creationDate: "2026-06-30T15:19:09.940Z",
		revisionDate: "2026-08-26T01:27:30.585Z",
		archivedDate: "2026-08-26T01:27:30.585Z",
	};

	it("imports an archived item as archived rather than live", async () => {
		const { context } = importContext();
		const res = await parseBitwarden(json({ items: [archivedItem] }), context);
		expect(res.imported[0]?.archivedAt).toBe(Date.parse("2026-08-26T01:27:30.585Z"));
	});

	// Archived is retired, not deleted. Bitwarden already excludes trash from exports, so
	// anything present was meant to be kept.
	it("keeps the archived item rather than dropping it", async () => {
		const { context } = importContext();
		const res = await parseBitwarden(json({ items: [archivedItem] }), context);
		expect(res.imported).toHaveLength(1);
		expect(res.imported[0]?.name).toBe("accounts.firefox.com");
	});

	it("leaves a live item unarchived", async () => {
		const { context } = importContext();
		const { archivedDate: _archivedDate, ...live } = archivedItem;
		const res = await parseBitwarden(json({ items: [live] }), context);
		expect(res.imported[0]?.archivedAt).toBeUndefined();
	});

	it("ignores an unparseable archivedDate instead of archiving on garbage", async () => {
		const { context } = importContext();
		const res = await parseBitwarden(
			json({ items: [{ ...archivedItem, archivedDate: "not-a-date" }] }),
			context,
		);
		expect(res.imported[0]?.archivedAt).toBeUndefined();
	});

	// Archiving is per item, not per type: a card or note must carry it as readily.
	it("applies to every item type, not just logins", async () => {
		const { context } = importContext();
		const res = await parseBitwarden(
			json({
				items: [
					{
						type: 2,
						name: "Note",
						secureNote: { type: 0 },
						archivedDate: "2026-08-26T01:00:00.000Z",
					},
					{
						type: 3,
						name: "Card",
						card: { number: "4111111111111111" },
						archivedDate: "2026-08-26T01:00:00.000Z",
					},
				],
			}),
			context,
		);
		expect(res.imported.map((e) => e.archivedAt)).toEqual([
			Date.parse("2026-08-26T01:00:00.000Z"),
			Date.parse("2026-08-26T01:00:00.000Z"),
		]);
	});
});

describe("parseBitwarden tags", () => {
	// Bitwarden's two organisational axes, both stored on the item as ids that only the
	// top-level `folders` / `collections` lists can resolve.
	it("resolves folder and collection ids to names and tags with them", async () => {
		const { context } = importContext();
		const res = await parseBitwarden(
			json({
				folders: [{ id: "f1", name: "Work" }],
				collections: [{ id: "c1", name: "Shared" }],
				items: [
					{
						type: 1,
						name: "GitHub",
						folderId: "f1",
						collectionIds: ["c1"],
						login: { username: "octo", password: "pw" },
					},
				],
			}),
			context,
		);
		expect(res.imported[0]?.tags).toEqual(["Work", "Shared"]);
	});

	// A raw UUID is noise the user cannot act on, so an unresolvable id is dropped.
	it("drops an id with no matching name rather than tagging with a UUID", async () => {
		const { context } = importContext();
		const res = await parseBitwarden(
			json({
				items: [
					{
						type: 1,
						name: "GitHub",
						folderId: "missing-id",
						login: { username: "octo", password: "pw" },
					},
				],
			}),
			context,
		);
		expect(res.imported[0]?.tags).toBeUndefined();
	});
});
