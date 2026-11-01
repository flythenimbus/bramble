import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { testParserContext } from "../exchange/test-crypto";
import { bytesToBase64 } from "../util/bytes";
import { parseProtonPass } from "./protonpass";

const ppx = (data: unknown): Uint8Array =>
	zipSync({ "Proton Pass/data.json": strToU8(JSON.stringify(data)) });

describe("parseProtonPass", () => {
	it("maps logins/cards/notes, keeps a distinct email, and skips trashed items", async () => {
		const res = await parseProtonPass(
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
			testParserContext,
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

	it("handles YYYY-MM expiry too", async () => {
		const res = await parseProtonPass(
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
			testParserContext,
		);
		expect(res.imported[0]).toMatchObject({ expMonth: "3", expYear: "2027" });
	});
});

describe("parseProtonPass tags", () => {
	// Proton organises by vault, which is the closest thing its export has to a tag.
	it("tags each item with the vault it came from", async () => {
		const res = await parseProtonPass(
			ppx({
				vaults: {
					v1: {
						name: "Work",
						items: [{ state: 1, data: { type: "login", metadata: { name: "Jira" }, content: {} } }],
					},
				},
			}),
			testParserContext,
		);
		expect(res.imported[0]?.tags).toEqual(["Work"]);
	});

	it("leaves tags off when the vault is unnamed", async () => {
		const res = await parseProtonPass(
			ppx({
				vaults: {
					v1: {
						items: [{ state: 1, data: { type: "login", metadata: { name: "Jira" }, content: {} } }],
					},
				},
			}),
			testParserContext,
		);
		expect(res.imported[0]?.tags).toBeUndefined();
	});
});

// Written by Proton Pass 1.43.0 for a throwaway webauthn.io account; see the fixtures README.
const REAL_CONTENT =
	"gqFj3AHCzIjMo2tlecyGzKNrdHnMgsyhdMymYXNzaWduzKFjzKNFQzLMo2tpZMyQzKNhbGfMgsyhdMymYXNzaWduzKFjzKVFUzI1Nsyka29wc8yQzKNiaXbMkMyjcGFyzJTMksyCzKF0zKNpbnTMoWPM/8yCzKF0zKNpbnTMoWPMgcylaW5uZXLM3AAQAQAAAAAAAAAAAAAAAAAAAMySzILMoXTMo2ludMyhY8z+zILMoXTMpWJ5dGVzzKFjzNwAIC9QzMzM9SjMzMyUzMzMwszMzPwBEczMzPhizMzMr8zMzPNKzMzMxMzMzNPMzMyRYw8qeMzMzM9PNszMzMvMzMyTzMzMm8zMzPlxFivMzMy7zJLMgsyhdMyjaW50zKFjzP3MgsyhdMylYnl0ZXPMoWPM3AAgEczMzIF9eG9oCWoVzMzMuczMzJzMzMzSzMzMimZcNszMzLTMzMzyAMzMzI7MzMz5eDMszMzMn8zMzMl7DMzMzLc/zMzM01DMksyCzKF0zKNpbnTMoWPM/MyCzKF0zKVieXRlc8yhY8zcACAvB8zMzMXMzMzPzMzMzszMzKHMzMy9zMzMqSQuAMzMzPjMzMzGzMzMwczMzIvMzMzXM8zMzOREUU/MzMyNzMzM18zMzLFiGVbMzMy0RSh5zMzM9cyjY2lkzNwAEMzMzNkHzMzM8czMzK/MzMzjJ8zMzKIpe8zMzPdtIE1PzMzMwMzMzKbMo3JpZMyrd2ViYXV0aG4uaW/Mo3VoZMzcABJ3ZWJhdXRobmlvLXRlc3RpbmfMo2NudMzAzKNleHTMgcyraG1hY19zZWNyZXTMwMyjdWRuzKd0ZXN0aW5nzKJ1bsyndGVzdGluZ6F2AQ==";
// COSE_Key built from the x and y Proton stored next to the scalar, so matching it proves we read
// the private key that belongs to the public key webauthn.io holds.
const REAL_PUBLIC_KEY_COSE =
	"pQECAyYgASFYIC9Q9SiUwvwBEfhir/NKxNORYw8qeM9PNsuTm/lxFiu7IlggEYF9eG9oCWoVuZzSimZcNrTyAI75eDMsn8l7DLc/01A=";

/** The subset of MessagePack rmp_serde writes for a ProtonPassKey, to build variants. */
function pack(v: unknown): number[] {
	const head = (fix: number, wide: number, n: number) =>
		n < 16 ? [fix | n] : [wide, n >> 8, n & 0xff];
	if (v === null) return [0xc0];
	if (typeof v === "number") {
		if (v >= -32 && v <= 0x7f) return [v & 0xff];
		if (v >= 0 && v <= 0xff) return [0xcc, v];
		throw new Error("pack: number out of range");
	}
	if (typeof v === "string") {
		const b = [...new TextEncoder().encode(v)];
		return b.length < 32 ? [0xa0 | b.length, ...b] : [0xd9, b.length, ...b];
	}
	// rmp_serde writes a Vec<u8> as an array of ints, not as bin.
	if (v instanceof Uint8Array) return pack([...v]);
	if (Array.isArray(v)) return [...head(0x90, 0xdc, v.length), ...v.flatMap(pack)];
	const entries = Object.entries(v as Record<string, unknown>);
	return [
		...head(0x80, 0xde, entries.length),
		...entries.flatMap(([k, x]) => [...pack(k), ...pack(x)]),
	];
}

const SCALAR = new Uint8Array(32).fill(0x11);
const protonRecord = (over: Record<string, unknown> = {}) => ({
	key: {
		kty: { t: "assign", c: "EC2" },
		kid: [],
		alg: { t: "assign", c: "ES256" },
		kops: [],
		biv: [],
		par: [
			[
				{ t: "int", c: -1 },
				{ t: "int", c: { inner: [1, ...new Array(15).fill(0)] } },
			],
			[
				{ t: "int", c: -4 },
				{ t: "bytes", c: SCALAR },
			],
		],
	},
	cid: new Uint8Array(16).fill(7),
	rid: "example.com",
	uhd: new Uint8Array([1, 2, 3]),
	cnt: null,
	ext: { hmac_secret: null },
	udn: "Alice",
	un: "alice",
	...over,
});
const protonContent = (record: unknown, version = 1) =>
	bytesToBase64(new Uint8Array(pack({ c: new Uint8Array(pack(record)), v: version })));

const loginWithPasskeys = (passkeys: unknown[]) =>
	ppx({
		vaults: {
			v1: {
				items: [
					{
						state: 1,
						createTime: 1700000000,
						data: {
							type: "login",
							metadata: { name: "Site" },
							content: { itemUsername: "alice", password: "", urls: [], passkeys },
						},
					},
				],
			},
		},
	});

describe("parseProtonPass passkeys", () => {
	it("imports a passkey Proton Pass wrote", async () => {
		const res = await parseProtonPass(
			loginWithPasskeys([
				{
					keyId: "2Qfxr-Mnoil7920gTU_Apg",
					content: REAL_CONTENT,
					domain: "webauthn.io",
					rpId: "webauthn.io",
					rpName: "webauthn.io",
					userName: "testing",
					userDisplayName: "testing",
					userId: "d2ViYXV0aG5pby10ZXN0aW5n",
					createTime: 1793504897,
					note: "",
					credentialId: "2Qfxr+Mnoil7920gTU/Apg==",
					userHandle: "d2ViYXV0aG5pby10ZXN0aW5n",
				},
			]),
			testParserContext,
		);
		expect(res.warnings).toEqual([]);
		const passkeys = res.imported[0]?.type === "login" ? res.imported[0].passkeys : undefined;
		expect(passkeys).toEqual([
			{
				credentialId: "2Qfxr+Mnoil7920gTU/Apg==",
				rpId: "webauthn.io",
				rpName: "webauthn.io",
				userHandle: "d2ViYXV0aG5pby10ZXN0aW5n",
				userName: "testing",
				userDisplayName: "testing",
				alg: -7,
				publicKeyCose: REAL_PUBLIC_KEY_COSE,
				privateKey: expect.any(String),
				signCount: 0,
				createdAt: 1793504897000,
			},
		]);
	});

	it("reads names from the record when the export leaves them out", async () => {
		const res = await parseProtonPass(
			loginWithPasskeys([{ content: protonContent(protonRecord()) }]),
			testParserContext,
		);
		const login = res.imported[0];
		expect(login?.type === "login" && login.passkeys?.[0]).toMatchObject({
			credentialId: bytesToBase64(new Uint8Array(16).fill(7)),
			rpId: "example.com",
			userHandle: "AQID",
			userName: "alice",
			userDisplayName: "Alice",
			privateKey: bytesToBase64(SCALAR),
			createdAt: 1700000000000,
		});
		expect(res.warnings).toEqual([
			'"Site" passkey 1 had no valid creation date; a fallback date was used.',
		]);
	});

	it("skips a passkey it can't read and keeps the login", async () => {
		const cases: [unknown, RegExp][] = [
			[{ content: protonContent(protonRecord(), 2) }, /newer Proton Pass format/],
			[
				{ content: protonContent(protonRecord({ key: { kty: { t: "assign", c: "OKP" } } })) },
				/key type other than P-256/,
			],
			[{ content: protonContent(protonRecord({ rid: "not a host" })) }, /invalid relying-party ID/],
			[{ content: protonContent(protonRecord({ uhd: null })) }, /no user handle/],
			[{ content: bytesToBase64(new TextEncoder().encode("hello")) }, /couldn't be read/],
			[{ content: 42 }, /unexpected shape/],
		];
		for (const [passkey, warning] of cases) {
			const res = await parseProtonPass(loginWithPasskeys([passkey]), testParserContext);
			expect(res.imported).toHaveLength(1);
			const login = res.imported[0];
			expect(login?.type === "login" && login.passkeys).toBeUndefined();
			expect(res.warnings).toEqual([expect.stringMatching(warning)]);
			expect(res.warnings[0]).toMatch(/^"Site" passkey 1 .*skipped\.$/);
		}
	});

	it("imports but says so when the counter is reset or a PRF secret is left behind", async () => {
		const res = await parseProtonPass(
			loginWithPasskeys([
				{
					createTime: 1793504897,
					content: protonContent(
						protonRecord({
							cnt: 5,
							ext: { hmac_secret: { cred_with_uv: SCALAR, cred_without_uv: null } },
						}),
					),
				},
			]),
			testParserContext,
		);
		const login = res.imported[0];
		expect(login?.type === "login" && login.passkeys).toHaveLength(1);
		expect(res.warnings).toEqual([
			'"Site" passkey 1 had its signature counter reset to zero.',
			expect.stringMatching(/^"Site" passkey 1 had a PRF secret/),
		]);
	});

	it("blames the crypto module, not the file, when no passkey converts", async () => {
		const res = await parseProtonPass(
			loginWithPasskeys([{ createTime: 1793504897, content: protonContent(protonRecord()) }]),
			{ passkeyImportPkcs8: () => Promise.reject(new Error("not wired")) },
		);
		expect(res.warnings).toEqual([
			'"Site" passkey 1 has invalid private-key material and was skipped.',
			expect.stringMatching(/crypto module is out of date/),
		]);
	});
});
