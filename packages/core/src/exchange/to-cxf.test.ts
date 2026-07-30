import { describe, expect, it } from "vitest";
import type { Entry, PasskeyCredential } from "../hooks/useVault";
import { base64UrlToBytes, bytesToBase64 } from "../util/bytes";
import { toCxf } from "./to-cxf";
import { type CxfCredential, cxfCredentialSchema } from "./types";

const OPTS = { exporterRpId: "app.bramble.mobile", exporterDisplayName: "Bramble", now: 1_760_000 };

const login = (over: Partial<Extract<Entry, { type: "login" }>> = {}): Entry => ({
	id: "e1",
	type: "login",
	name: "GitHub",
	urls: ["https://github.com"],
	username: "octocat",
	password: "pw",
	...over,
});

const run = (e: Entry) => toCxf([e], OPTS);

/** A stored passkey: `privateKey` is the RAW 32-byte scalar, as core-rust writes it. */
const passkey = (over: Partial<PasskeyCredential> = {}): PasskeyCredential => ({
	credentialId: bytesToBase64(new Uint8Array(16).fill(1)),
	rpId: "github.com",
	userHandle: bytesToBase64(new Uint8Array(8).fill(2)),
	userName: "octocat",
	alg: -7,
	publicKeyCose: bytesToBase64(new Uint8Array(77).fill(3)),
	privateKey: bytesToBase64(new Uint8Array(32).fill(4)),
	signCount: 0,
	createdAt: 1,
	...over,
});

/** The emitted credentials, re-parsed through the schema so the test also proves we emit valid CXF. */
function creds(e: Entry): CxfCredential[] {
	const raw = run(e).payload.accounts?.[0]?.items?.[0]?.credentials ?? [];
	return raw.map((c) => cxfCredentialSchema.parse(c));
}

function cred<T extends CxfCredential["type"]>(
	e: Entry,
	type: T,
): Extract<CxfCredential, { type: T }> | undefined {
	return creds(e).find((c) => c.type === type) as Extract<CxfCredential, { type: T }> | undefined;
}

describe("toCxf: envelope", () => {
	it("emits the wire shape Apple decodes: version object, UNIX-second timestamp", () => {
		const { payload } = run(login());
		expect(payload.version).toEqual({ major: 1, minor: 0 });
		expect(payload.exporterRpId).toBe("app.bramble.mobile");
		expect(payload.exporterDisplayName).toBe("Bramble");
		expect(payload.timestamp).toBe(1760);
	});

	it("puts every entry under one account, since a local vault has no account identity", () => {
		const { payload } = toCxf([login(), login({ id: "e2", name: "Fastmail" })], OPTS);
		expect(payload.accounts).toHaveLength(1);
		expect(payload.accounts?.[0]?.items).toHaveLength(2);
		expect(payload.accounts?.[0]?.username).toBe("");
	});

	it("converts entry timestamps from ms to seconds", () => {
		const item = run(login({ createdAt: 1_700_000_000_000, updatedAt: 1_750_000_500_000 })).payload
			.accounts?.[0]?.items?.[0];
		expect(item?.creationAt).toBe(1_700_000_000);
		expect(item?.modifiedAt).toBe(1_750_000_500);
	});
});

describe("toCxf: logins", () => {
	it("maps username and password, concealing only the password", () => {
		const c = cred(login(), "basic-auth");
		expect(c?.username).toEqual({ fieldType: "string", value: "octocat" });
		expect(c?.password).toEqual({ fieldType: "concealed-string", value: "pw" });
	});

	it("carries every url in scope, promoting a bare host to https", () => {
		const item = run(login({ urls: ["https://github.com", "gist.github.com"] })).payload
			.accounts?.[0]?.items?.[0];
		expect(item?.scope?.urls).toEqual(["https://github.com", "https://gist.github.com"]);
	});

	it("splits a stored otpauth uri into the structured TOTP fields", () => {
		const uri = "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=8";
		const c = cred(login({ totp: uri }), "totp");
		expect(c?.secret).toBe("JBSWY3DPEHPK3PXP");
		expect(c?.digits).toBe(8);
		expect(c?.period).toBe(30);
		expect(c?.algorithm).toBe("sha1");
		expect(c?.issuer).toBe("GitHub");
	});

	it("keeps an unreadable one-time-code key as a custom field instead of dropping it", () => {
		const e = login({ totp: "otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1" });
		expect(cred(e, "totp")).toBeUndefined();
		expect(cred(e, "custom-fields")?.fields).toContainEqual({
			fieldType: "concealed-string",
			value: "otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1",
			label: "TOTP",
		});
		expect(run(e).warnings[0]).toMatch(/one-time-code/);
	});

	it("re-encodes passkey ids from our standard base64 to CXF's unpadded base64url", () => {
		// 0xfb 0xff 0xbe -> standard "+/++", base64url "-_--", and the padding must go.
		const b64 = bytesToBase64(new Uint8Array([0xfb, 0xff, 0xbe]));
		const c = cred(
			login({ passkeys: [passkey({ credentialId: b64, userHandle: b64 })] }),
			"passkey",
		);
		expect(c?.credentialId).toBe("-_--");
		expect(c?.userHandle).toBe("-_--");
		expect(c?.rpId).toBe("github.com");
		// CXF requires both names; ours are optional, so the display name falls back.
		expect(c?.username).toBe("octocat");
		expect(c?.userDisplayName).toBe("octocat");
	});

	it("wraps the stored scalar as PKCS#8, which is what CXF's `key` holds", () => {
		const c = cred(login({ passkeys: [passkey()] }), "passkey");
		const der = base64UrlToBytes(c?.key ?? "");
		expect(der).toHaveLength(67);
		// SEQUENCE, version 0, then the ecPublicKey/prime256v1 AlgorithmIdentifier.
		expect([...der.slice(0, 7)]).toEqual([0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13]);
	});

	it("leaves behind a passkey whose key isn't a P-256 scalar, and says so", () => {
		const e = login({ passkeys: [passkey({ privateKey: bytesToBase64(new Uint8Array(3)) })] });
		expect(cred(e, "passkey")).toBeUndefined();
		expect(run(e).warnings[0]).toMatch(/passkey/);
	});
});

describe("toCxf: other entry types", () => {
	it("maps a card, joining the expiry into a single year-month field", () => {
		const card: Entry = {
			id: "c1",
			type: "card",
			name: "Visa",
			cardholderName: "Ada Lovelace",
			number: "4111111111111111",
			brand: "visa",
			expMonth: "4",
			expYear: "2030",
			cvv: "123",
		};
		const c = cred(card, "credit-card");
		expect(c?.expiryDate).toEqual({ fieldType: "year-month", value: "2030-04" });
		expect(c?.number?.fieldType).toBe("concealed-string");
		expect(c?.verificationNumber?.value).toBe("123");
		expect(c?.fullName?.value).toBe("Ada Lovelace");
	});

	it("sends an SSH key as custom fields, since CXF wants PKCS#8 and we hold PEM", () => {
		const ssh: Entry = {
			id: "s1",
			type: "ssh-key",
			name: "deploy key",
			publicKey: "ssh-ed25519 AAAA",
			privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
			keyType: "ed25519",
		};
		const c = cred(ssh, "custom-fields");
		expect(c?.fields?.map((f) => f.label)).toEqual(["Key Type", "Public Key", "Private Key"]);
		expect(c?.fields?.find((f) => f.label === "Private Key")?.fieldType).toBe("concealed-string");
		expect(run(ssh).warnings[0]).toMatch(/SSH key/);
	});

	it("gives an otherwise empty entry a note credential, because CXF items need one", () => {
		const note: Entry = { id: "n1", type: "note", name: "Empty" };
		expect(creds(note)).toEqual([{ type: "note", content: { fieldType: "string", value: "" } }]);
	});

	it("puts notes on any entry type as a note credential", () => {
		expect(cred(login({ notes: "recovery kit in the safe" }), "note")?.content?.value).toBe(
			"recovery kit in the safe",
		);
	});
});
