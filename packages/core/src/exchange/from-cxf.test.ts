import { beforeAll, describe, expect, it } from "vitest";
import { isLogin } from "../hooks/useVault";
import { base64ToBase64Url, base64UrlToBase64, bytesToBase64Url } from "../util/bytes";
import { parseCxf } from "./from-cxf";

/** A real P-256 key, so the COSE derivation under test runs against a genuine PKCS#8 blob. */
let keyB64Url = "";

beforeAll(async () => {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	]);
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
	keyB64Url = bytesToBase64Url(pkcs8);
});

const payload = (...credentials: unknown[]) =>
	JSON.stringify({
		version: { major: 1, minor: 0 },
		exporterRpId: "com.apple.Passwords",
		exporterDisplayName: "Passwords",
		timestamp: 1_760_000,
		accounts: [
			{
				id: "YWNjdA",
				username: "ada",
				email: "ada@example.com",
				collections: [],
				items: [
					{
						id: "aXRlbQ",
						title: "GitHub",
						creationAt: 1_700_000_000,
						modifiedAt: 1_750_000_500,
						scope: { urls: ["https://github.com"], androidApps: [] },
						credentials,
					},
				],
			},
		],
	});

const basicAuth = {
	type: "basic-auth",
	username: { fieldType: "string", value: "octocat" },
	password: { fieldType: "concealed-string", value: "pw" },
};

const first = async (...credentials: unknown[]) => {
	const res = await parseCxf(payload(...credentials));
	return { res, entry: res.imported[0] };
};

describe("parseCxf: logins", () => {
	it("maps basic-auth, scope urls and timestamps back to a login", async () => {
		const { entry } = await first(basicAuth);
		expect(entry).toMatchObject({
			type: "login",
			name: "GitHub",
			username: "octocat",
			password: "pw",
			urls: ["https://github.com"],
			createdAt: 1_700_000_000_000,
			updatedAt: 1_750_000_500_000,
		});
	});

	it("rebuilds an otpauth uri from the structured TOTP fields", async () => {
		const { entry } = await first(basicAuth, {
			type: "totp",
			secret: "JBSWY3DPEHPK3PXP",
			period: 60,
			digits: 8,
			algorithm: "sha256",
			issuer: "GitHub",
			username: "octocat",
		});
		if (!entry || !isLogin(entry)) throw new Error("expected a login");
		expect(entry.totp).toContain("secret=JBSWY3DPEHPK3PXP");
		expect(entry.totp).toContain("digits=8");
		expect(entry.totp).toContain("period=60");
		expect(entry.totp).toContain("algorithm=SHA256");
	});

	it("keeps an unreadable TOTP secret as a custom field and warns", async () => {
		const { res, entry } = await first(basicAuth, { type: "totp", secret: "not base32 !!" });
		if (!entry || !isLogin(entry)) throw new Error("expected a login");
		expect(entry.totp).toBeUndefined();
		expect(entry.customFields).toContainEqual({
			key: "TOTP",
			value: "not base32 !!",
			hidden: true,
		});
		expect(res.warnings[0]).toMatch(/one-time-code/);
	});
});

describe("parseCxf: passkeys", () => {
	it("stores the key as standard base64, derives the COSE public key, and zeroes signCount", async () => {
		const { entry } = await first({
			type: "passkey",
			credentialId: "-_--",
			rpId: "github.com",
			username: "octocat",
			userDisplayName: "Octo Cat",
			userHandle: "-_--",
			key: keyB64Url,
		});
		if (!entry || !isLogin(entry)) throw new Error("expected a login");
		const [pk] = entry.passkeys ?? [];
		expect(pk?.credentialId).toBe(base64UrlToBase64("-_--"));
		expect(pk?.privateKey).toBe(base64UrlToBase64(keyB64Url));
		expect(pk?.rpId).toBe("github.com");
		expect(pk?.alg).toBe(-7);
		expect(pk?.signCount).toBe(0);
		// COSE_Key EC2/P-256: map(5), kty 2, alg -7, crv 1, then the two 32-byte coordinates.
		const cose = base64ToBase64Url(pk?.publicKeyCose ?? "");
		expect(cose).not.toBe("");
		expect([...atob(pk?.publicKeyCose ?? "")].map((c) => c.charCodeAt(0)).slice(0, 7)).toEqual([
			0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01,
		]);
	});

	it("skips a passkey whose key we can't read, keeping the rest of the item", async () => {
		const { res, entry } = await first(basicAuth, {
			type: "passkey",
			credentialId: "-_--",
			rpId: "github.com",
			userHandle: "-_--",
			key: bytesToBase64Url(new Uint8Array([1, 2, 3])),
		});
		if (!entry || !isLogin(entry)) throw new Error("expected a login");
		expect(entry.username).toBe("octocat");
		expect(entry.passkeys).toBeUndefined();
		expect(res.warnings[0]).toMatch(/passkey/);
	});
});

describe("parseCxf: other credential types", () => {
	it("splits a card's year-month expiry back into month and year", async () => {
		const { entry } = await first({
			type: "credit-card",
			number: { fieldType: "concealed-string", value: "4111111111111111" },
			fullName: { fieldType: "string", value: "Ada Lovelace" },
			verificationNumber: { fieldType: "concealed-string", value: "123" },
			expiryDate: { fieldType: "year-month", value: "2030-04" },
		});
		expect(entry).toMatchObject({
			type: "card",
			number: "4111111111111111",
			cardholderName: "Ada Lovelace",
			cvv: "123",
			expMonth: "4",
			expYear: "2030",
			// No cardType on the wire, so the brand is derived from the number.
			brand: "Visa",
		});
	});

	it("wraps a CXF ssh key's PKCS#8 DER back into PEM", async () => {
		const der = bytesToBase64Url(new Uint8Array([0x30, 0x81, 0x87, 0x02, 0x01, 0x00]));
		const { entry } = await first({ type: "ssh-key", keyType: "ssh-ed25519", privateKey: der });
		expect(entry).toMatchObject({ type: "ssh-key", keyType: "ssh-ed25519" });
		const pem = entry && "privateKey" in entry ? entry.privateKey : "";
		expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
		expect(pem).toContain(base64UrlToBase64(der));
	});

	it("salvages a credential type we don't model into custom fields, and says so", async () => {
		const { res, entry } = await first({ type: "passport", passportNumber: "X123", country: "GB" });
		expect(entry).toMatchObject({ type: "note", name: "GitHub" });
		expect(entry?.customFields).toEqual([
			{ key: "passportNumber", value: "X123" },
			{ key: "country", value: "GB" },
		]);
		expect(res.warnings[0]).toMatch(/passport/);
	});

	it("salvages a modelled type that arrived malformed rather than dropping the item", async () => {
		// No `secret`, so it fails the TOTP schema and falls through to the salvage path.
		const { res, entry } = await first({ type: "totp", issuer: "GitHub" });
		expect(entry?.customFields).toEqual([{ key: "issuer", value: "GitHub" }]);
		expect(res.warnings[0]).toMatch(/totp/);
	});

	it("folds several notes into one entry and joins them", async () => {
		const note = (value: string) => ({ type: "note", content: { fieldType: "string", value } });
		const { entry } = await first(note("first"), note("second"));
		expect(entry).toMatchObject({ type: "note", notes: "first\n\nsecond" });
	});
});

describe("parseCxf: robustness", () => {
	it("skips an item with nothing in it", async () => {
		const res = await parseCxf(payload());
		expect(res.imported).toHaveLength(0);
		expect(res.skipped).toBe(1);
	});

	it("throws on input that isn't CXF at all", async () => {
		await expect(parseCxf("not json")).rejects.toThrow(/credential exchange/);
		await expect(parseCxf('{"hello":"world"}')).rejects.toThrow(/credential exchange/);
	});

	it("accepts bytes as well as text, so a CXF file drops into the same path", async () => {
		const bytes = new TextEncoder().encode(payload(basicAuth));
		const res = await parseCxf(bytes);
		expect(res.imported).toHaveLength(1);
	});
});
