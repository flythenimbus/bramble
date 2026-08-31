import { describe, expect, it, vi } from "vitest";
import { entryContentKey } from "../vault/entry-identity";
import { kdbxEntriesToResult } from "./kdbx";
import { parseKeePass } from "./keepass";
import { convertKeepassPasskey } from "./keepass-passkey";
import type { ConversionTally } from "./passkey-fields";
import type { RawField } from "./shared";

// A throwaway Ed25519 key, generated for these tests and nothing else. Ed25519 rather than
// P-256 because that is what KeePassXC actually writes: it prefers EdDSA whenever the site
// offers it, so an ES256-only fixture would test a case users rarely have.
const PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIOOO0h6TPWiDuKE/5iLREORnBCswBsTNmP6RRAqHpA6z
-----END PRIVATE KEY-----`;

/** Stands in for the crypto core, which reads the algorithm off the key's OID. */
const converter = (alg = -8) =>
	vi.fn(async () => ({ privateKey: "c2VlZA==", publicKeyCose: "Y29zZQ==", alg }));

const attrs = (over: Record<string, string | undefined> = {}): RawField[] => {
	const base: Record<string, string | undefined> = {
		Title: "webauthn.io (Passkey)",
		UserName: "testy",
		KPEX_PASSKEY_CREDENTIAL_ID: "_lt5pHIIIowqyWHmHwPxBdxXYmxge4sSpTaWy1XOs6Q",
		KPEX_PASSKEY_PRIVATE_KEY_PEM: PEM,
		KPEX_PASSKEY_RELYING_PARTY: "webauthn.io",
		KPEX_PASSKEY_USERNAME: "testy",
		KPEX_PASSKEY_USER_HANDLE: "d2ViYXV0aG5pby10ZXN0eQ",
		KPEX_PASSKEY_FLAG_BE: "1",
		KPEX_PASSKEY_FLAG_BS: "1",
		...over,
	};
	return Object.entries(base)
		.filter(([, v]) => v !== undefined)
		.map(([key, value]) => ({
			key,
			value: value as string,
			// KeePassXC marks these three protected; the rest are plain.
			hidden: [
				"KPEX_PASSKEY_CREDENTIAL_ID",
				"KPEX_PASSKEY_PRIVATE_KEY_PEM",
				"KPEX_PASSKEY_USER_HANDLE",
			].includes(key),
		}));
};

const run = async (fields: RawField[], convert = converter()) => {
	const warnings: string[] = [];
	const tally: ConversionTally = { converted: 0, failed: 0 };
	const out = await convertKeepassPasskey(
		fields,
		"webauthn.io (Passkey)",
		1_700_000_000_000,
		{ passkeyImportPkcs8: convert },
		warnings,
		tally,
	);
	return { ...out, warnings, tally, convert };
};

describe("convertKeepassPasskey", () => {
	it("converts a full KeePassXC passkey and keeps the algorithm the core reported", async () => {
		const { credential, convert } = await run(attrs());
		expect(credential).toEqual({
			credentialId: "/lt5pHIIIowqyWHmHwPxBdxXYmxge4sSpTaWy1XOs6Q=",
			rpId: "webauthn.io",
			userHandle: "d2ViYXV0aG5pby10ZXN0eQ==",
			userName: "testy",
			alg: -8,
			publicKeyCose: "Y29zZQ==",
			privateKey: "c2VlZA==",
			signCount: 0,
			createdAt: 1_700_000_000_000,
		});
		// The PEM reaches the core de-armored, as standard base64 with no newlines.
		expect(convert).toHaveBeenCalledWith(
			"MC4CAQAwBQYDK2VwBCIEIOOO0h6TPWiDuKE/5iLREORnBCswBsTNmP6RRAqHpA6z",
		);
	});

	it("drops every KPEX field once the passkey is stored", async () => {
		// Otherwise the private key would sit in a plaintext custom field beside the credential
		// that already holds it.
		const { fields } = await run(attrs());
		expect(fields.map((f) => f.key)).toEqual(["Title", "UserName"]);
	});

	it("keeps the fields untouched when conversion fails", async () => {
		// A passkey we cannot read is still the user's only copy; dropping it silently would be
		// worse than showing it raw.
		const { credential, fields, warnings, tally } = await run(
			attrs({ KPEX_PASSKEY_RELYING_PARTY: "not a hostname!" }),
		);
		expect(credential).toBeNull();
		expect(fields.map((f) => f.key)).toContain("KPEX_PASSKEY_PRIVATE_KEY_PEM");
		expect(fields.find((f) => f.key === "KPEX_PASSKEY_PRIVATE_KEY_PEM")?.hidden).toBe(true);
		expect(warnings[0]).toMatch(/invalid relying-party ID/);
		expect(tally).toEqual({ converted: 0, failed: 1 });
	});

	it("names the missing field rather than failing generically", async () => {
		const cases: [string, RegExp][] = [
			["KPEX_PASSKEY_CREDENTIAL_ID", /credential ID/],
			["KPEX_PASSKEY_PRIVATE_KEY_PEM", /private key/],
			["KPEX_PASSKEY_RELYING_PARTY", /relying-party ID/],
			["KPEX_PASSKEY_USER_HANDLE", /user handle/],
		];
		for (const [missing, expected] of cases) {
			const { credential, warnings } = await run(attrs({ [missing]: undefined }));
			expect(credential, missing).toBeNull();
			expect(warnings[0], missing).toMatch(expected);
		}
	});

	it("falls back to the legacy user-handle attribute", async () => {
		const { credential } = await run(
			attrs({
				KPEX_PASSKEY_USER_HANDLE: undefined,
				KPEX_PASSKEY_GENERATED_USER_ID: "d2ViYXV0aG5pby10ZXN0eQ",
			}),
		);
		expect(credential?.userHandle).toBe("d2ViYXV0aG5pby10ZXN0eQ==");
	});

	it("rejects an oversized PEM before decoding it", async () => {
		const { credential, warnings, convert } = await run(
			attrs({
				KPEX_PASSKEY_PRIVATE_KEY_PEM: `-----BEGIN PRIVATE KEY-----\n${"A".repeat(9000)}\n-----END PRIVATE KEY-----`,
			}),
		);
		expect(credential).toBeNull();
		expect(warnings[0]).toMatch(/character maximum/);
		// The cap is the point: nothing that large should reach the crypto bridge at all.
		expect(convert).not.toHaveBeenCalled();
	});

	it("says so when the key is SEC1 rather than PKCS#8", async () => {
		const { credential, warnings } = await run(
			attrs({
				KPEX_PASSKEY_PRIVATE_KEY_PEM:
					"-----BEGIN EC PRIVATE KEY-----\nMHc=\n-----END EC PRIVATE KEY-----",
			}),
		);
		expect(credential).toBeNull();
		expect(warnings[0]).toMatch(/SEC1/);
	});

	it("never puts the crypto core's error text in a warning", async () => {
		// That error can name bytes of the key, so it is suppressed in favour of a fixed line.
		const leaky = vi.fn(async () => {
			throw new Error("invalid byte 0x41 at offset 7");
		});
		const { credential, warnings, tally } = await run(attrs(), leaky);
		expect(credential).toBeNull();
		expect(warnings[0]).not.toMatch(/0x41|offset/);
		expect(warnings[0]).toMatch(/key material we can't read/);
		expect(tally).toEqual({ converted: 0, failed: 1 });
	});

	it("leaves an entry with no passkey attributes completely alone", async () => {
		const plain: RawField[] = [{ key: "Title", value: "GitHub" }];
		const { credential, fields, tally, convert } = await run(plain);
		expect(credential).toBeNull();
		expect(fields).toBe(plain);
		expect(tally).toEqual({ converted: 0, failed: 0 });
		expect(convert).not.toHaveBeenCalled();
	});
});

// The two KeePass paths hand us the same attributes from different containers. Import
// de-duplication hashes the whole entry including its passkeys, so if these ever diverged,
// importing the XML and then the .kdbx of one database would store the private key twice and
// neither copy would be recognisable as the other's duplicate.
describe("the XML and .kdbx paths agree byte for byte", () => {
	const attributes = [
		["Title", "webauthn.io (Passkey)"],
		["UserName", "testy"],
		["KPEX_PASSKEY_CREDENTIAL_ID", "_lt5pHIIIowqyWHmHwPxBdxXYmxge4sSpTaWy1XOs6Q"],
		["KPEX_PASSKEY_PRIVATE_KEY_PEM", PEM],
		["KPEX_PASSKEY_RELYING_PARTY", "webauthn.io"],
		["KPEX_PASSKEY_USERNAME", "testy"],
		["KPEX_PASSKEY_USER_HANDLE", "d2ViYXV0aG5pby10ZXN0eQ"],
	] as const;

	it("produces the same content key from both containers", async () => {
		const xml = `<?xml version="1.0"?><KeePassFile><Root><Group><Name>Root</Name><Entry>${attributes
			.map(([k, v]) => `<String><Key>${k}</Key><Value>${v}</Value></String>`)
			.join("")}</Entry></Group></Root></KeePassFile>`;

		const fromXml = await parseKeePass(xml, { passkeyImportPkcs8: converter() });
		const fromKdbx = await kdbxEntriesToResult(
			[{ strings: attributes.map(([key, value]) => ({ key, value, protected: false })) }],
			{ passkeyImportPkcs8: converter() },
		);

		const a = fromXml.imported[0];
		const b = fromKdbx.imported[0];
		expect(a).toBeDefined();
		expect((a as { passkeys?: unknown[] }).passkeys).toHaveLength(1);
		// Content keys, not deep equality: this is exactly what splitAlreadyImported compares,
		// and it strips the nested createdAt the two runs would otherwise disagree on.
		expect(entryContentKey(a as Parameters<typeof entryContentKey>[0])).toBe(
			entryContentKey(b as Parameters<typeof entryContentKey>[0]),
		);
	});
});
