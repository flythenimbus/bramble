import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { testParserContext } from "../exchange/test-crypto";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import { parseProtonPass } from "./protonpass";
import type { ImportAttachment } from "./types";

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

	const importOne = async (over: Record<string, unknown>) => {
		const res = await parseProtonPass(
			loginWithPasskeys([{ createTime: 1793504897, content: protonContent(protonRecord(over)) }]),
			testParserContext,
		);
		const login = res.imported[0];
		return { res, passkey: login?.type === "login" ? login.passkeys?.[0] : undefined };
	};

	it("keeps the PRF secret and warns only about the counter", async () => {
		const { res, passkey } = await importOne({
			cnt: 5,
			ext: { hmac_secret: { cred_with_uv: SCALAR, cred_without_uv: null } },
		});
		expect(passkey?.prf?.credWithUV).toBe(bytesToBase64(SCALAR));
		// Proton never produced a without-UV output, so a fresh half loses nothing; CXF needs both.
		expect(base64ToBytes(passkey?.prf?.credWithoutUV ?? "")).toHaveLength(32);
		expect(passkey?.prf?.credWithoutUV).not.toBe(passkey?.prf?.credWithUV);
		expect(res.warnings).toEqual(['"Site" passkey 1 had its signature counter reset to zero.']);
	});

	it("keeps both halves when Proton has both", async () => {
		const withoutUV = new Uint8Array(32).fill(0x22);
		const { passkey } = await importOne({
			ext: { hmac_secret: { cred_with_uv: SCALAR, cred_without_uv: withoutUV } },
		});
		expect(passkey?.prf).toEqual({
			credWithUV: bytesToBase64(SCALAR),
			credWithoutUV: bytesToBase64(withoutUV),
		});
	});

	it("warns and leaves the PRF secret out when it can't be read", async () => {
		const { res, passkey } = await importOne({ ext: { hmac_secret: "junk" } });
		expect(passkey).toBeDefined();
		expect(passkey?.prf).toBeUndefined();
		expect(res.warnings).toEqual([
			expect.stringMatching(/^"Site" passkey 1 had a PRF secret Bramble couldn't read/),
		]);
	});

	it("imports no PRF secret when Proton has none", async () => {
		const { res, passkey } = await importOne({});
		expect(passkey?.prf).toBeUndefined();
		expect(res.warnings).toEqual([]);
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

// Proton names each exported file <base>.<hex |hash(shareId)|><hex |hash(fileID)|><ext>, with the
// Java-style string hash. "hello" hashes to 99162322 (5e918d2); "polygenelubricants" to -2^31.
const oneVault = (...items: Record<string, unknown>[]) => ({
	vaults: { v1: { items: items.map((item) => ({ state: 1, ...item })) } },
});
const ppxWith = (data: unknown, files: Record<string, string> = {}): Uint8Array =>
	zipSync({
		"Proton Pass/data.json": strToU8(JSON.stringify(data)),
		...Object.fromEntries(
			Object.entries(files).map(([name, body]) => [`Proton Pass/files/${name}`, strToU8(body)]),
		),
	});
const text = async (a: ImportAttachment | undefined) =>
	a?.source.kind === "blob" ? await a.source.blob.text() : undefined;

describe("parseProtonPass files", () => {
	it("carries each item's files across under the names they had in Proton", async () => {
		const res = await parseProtonPass(
			ppxWith(
				oneVault(
					{
						shareId: "hello",
						files: ["sample.5e918d28f86536.pdf", "README.5e918d2431b8ed6"],
						data: { type: "login", metadata: { name: "Test" }, content: {} },
					},
					{
						shareId: "hello",
						files: ["notes.5e918d2ff.txt"],
						data: { type: "note", metadata: { name: "Notes" } },
					},
				),
				{
					"sample.5e918d28f86536.pdf": "pdf bytes",
					"README.5e918d2431b8ed6": "readme",
					"notes.5e918d2ff.txt": "note",
				},
			),
			testParserContext,
		);
		const [login, note] = res.imported;
		expect(res.attachments?.map((a) => [a.entry, a.name, a.mime, a.size])).toEqual([
			[login, "sample.pdf", "application/pdf", 9],
			[login, "README", "application/octet-stream", 6],
			[note, "notes.txt", "text/plain", 4],
		]);
		expect(await text(res.attachments?.[0])).toBe("pdf bytes");
		expect(res.warnings).toEqual([]);
	});

	it("reads the vault's half of the name with the sign bit set", async () => {
		const res = await parseProtonPass(
			ppxWith(
				oneVault({
					shareId: "polygenelubricants",
					files: ["scan.80000000c0ffee.png"],
					data: { type: "note", metadata: { name: "Scan" } },
				}),
				{ "scan.80000000c0ffee.png": "png" },
			),
			testParserContext,
		);
		expect(res.attachments?.map((a) => a.name)).toEqual(["scan.png"]);
	});

	it("finds a file Proton renamed on its way into the zip", async () => {
		const res = await parseProtonPass(
			ppxWith(
				oneVault({
					shareId: "hello",
					files: ["a\\b.5e918d21.txt"],
					data: { type: "note", metadata: { name: "Note" } },
				}),
				{ "a_b.5e918d21.txt": "slashed" },
			),
			testParserContext,
		);
		expect(res.attachments?.map((a) => a.name)).toEqual(["a_b.txt"]);
		expect(await text(res.attachments?.[0])).toBe("slashed");
	});

	it("keeps the export's name when it doesn't carry the vault's hash", async () => {
		const res = await parseProtonPass(
			ppxWith(
				oneVault({
					shareId: "hello",
					files: ["odd.name.txt"],
					data: { type: "note", metadata: { name: "Note" } },
				}),
				{ "odd.name.txt": "odd" },
			),
			testParserContext,
		);
		expect(res.attachments?.map((a) => a.name)).toEqual(["odd.name.txt"]);
	});

	it("says so when an item names a file the export does not hold", async () => {
		const res = await parseProtonPass(
			ppxWith(
				oneVault({
					shareId: "hello",
					files: ["gone.5e918d21.pdf"],
					data: { type: "note", metadata: { name: "Note" } },
				}),
			),
			testParserContext,
		);
		expect(res.imported).toHaveLength(1);
		expect(res.attachments).toBeUndefined();
		expect(res.warnings).toEqual([
			"1 attachment(s) are named in this export but not stored in it.",
		]);
	});
});

// autofillUrls carries every website with its rule; urls repeats only the Default ones.
const loginWithUrls = (content: Record<string, unknown>) =>
	ppxWith(oneVault({ data: { type: "login", metadata: { name: "Site" }, content } }));

describe("parseProtonPass websites", () => {
	it("keeps every website, whatever Proton's rule for it", async () => {
		const res = await parseProtonPass(
			loginWithUrls({
				autofillUrls: [
					{ url: "https://default.example.com/", mode: 0 },
					{ url: "https://exact.example.com/login", mode: 1 },
					{ url: "https://starts.example.com/app", mode: 3 },
					{ url: "*.pattern.example.com", mode: 4 },
					{ url: "^https://regex\\.example\\.com/", mode: 5 },
					{ url: "https://path.example.com/a/b", mode: 6 },
				],
				urls: ["https://default.example.com/"],
			}),
			testParserContext,
		);
		expect(res.imported[0]).toMatchObject({
			urls: [
				"https://default.example.com/",
				"https://exact.example.com/login",
				"https://starts.example.com/app",
				"*.pattern.example.com",
				"^https://regex\\.example\\.com/",
				"https://path.example.com/a/b",
			],
			subdomainMatch: "exact",
		});
		expect(res.warnings).toEqual([
			"5 website(s) had a Proton autofill rule Bramble doesn't have, so their logins now match the exact site only.",
		]);
	});

	it("keeps a never-autofill website out of the login's websites, in a field", async () => {
		const res = await parseProtonPass(
			loginWithUrls({
				autofillUrls: [
					{ url: "https://youtube.com/", mode: 2 },
					{ url: "https://yt.com/", mode: 1 },
				],
				urls: [],
			}),
			testParserContext,
		);
		expect(res.imported[0]).toMatchObject({
			urls: ["https://yt.com/"],
			subdomainMatch: "exact",
			customFields: [{ key: "Never autofill on", value: "https://youtube.com/" }],
		});
		expect(res.warnings).toEqual([
			"1 website(s) had a Proton autofill rule Bramble doesn't have, so their logins now match the exact site only.",
			"1 website(s) were set to never autofill in Proton, so they're kept in a \"Never autofill on\" field instead of the login's websites.",
		]);
	});

	it("leaves matching alone on the default rule, and keeps a website only urls lists", async () => {
		const res = await parseProtonPass(
			loginWithUrls({
				autofillUrls: [{ url: "https://a.example.com/", mode: 0 }],
				urls: ["https://a.example.com/", "https://b.example.com/"],
			}),
			testParserContext,
		);
		const login = res.imported[0];
		expect(login).toMatchObject({ urls: ["https://a.example.com/", "https://b.example.com/"] });
		expect(login?.type === "login" && login.subdomainMatch).toBeUndefined();
		expect(res.warnings).toEqual([]);
	});
});
