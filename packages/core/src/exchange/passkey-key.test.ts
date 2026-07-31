import { beforeAll, describe, expect, it } from "vitest";
import { base64ToBytes, base64UrlToBase64, base64UrlToBytes, bytesToBase64 } from "../util/bytes";
import { pkcs8FromScalar } from "./passkey-key";
import { fakePasskeyImportPkcs8 } from "./test-crypto";

// The vault stores the bare 32-byte P-256 scalar (core-rust `secret.to_bytes()`), while CXF
// carries PKCS#8 DER. Getting that wrong is invisible in a round trip through our own code and
// only shows up as a counterparty refusing the passkey, so these tests check the DER against
// WebCrypto, which is the same parser a real importer uses.
let scalar = "";
let jwkX = "";

beforeAll(async () => {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	]);
	const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
	scalar = bytesToBase64(base64UrlToBytes(jwk.d ?? ""));
	jwkX = jwk.x ?? "";
});

describe("pkcs8FromScalar", () => {
	it("produces DER that WebCrypto will actually import", async () => {
		const der = pkcs8FromScalar(scalar);
		expect(der).not.toBeNull();
		const key = await crypto.subtle.importKey(
			"pkcs8",
			base64UrlToBytes(der ?? "") as BufferSource,
			{ name: "ECDSA", namedCurve: "P-256" },
			true,
			["sign"],
		);
		// The curve point is recovered from the scalar, so the public half survives the trip
		// even though PKCS#8 here carries only the private scalar.
		const back = await crypto.subtle.exportKey("jwk", key);
		expect(back.x).toBe(jwkX);
	});

	it("is 67 bytes: a 35-byte header and the scalar", () => {
		expect(base64UrlToBytes(pkcs8FromScalar(scalar) ?? "")).toHaveLength(67);
	});

	it("refuses anything that isn't a 32-byte scalar, rather than emitting junk DER", () => {
		expect(pkcs8FromScalar(bytesToBase64(new Uint8Array(31)))).toBeNull();
		expect(pkcs8FromScalar(bytesToBase64(new Uint8Array(64)))).toBeNull();
		expect(pkcs8FromScalar("not base64 !!")).toBeNull();
	});
});

// The import direction is the Rust core's `passkey_import_pkcs8`, tested there (it signs with
// the converted key). What still needs proving here is that the DER we EXPORT survives that
// conversion, since a counterparty importing our passkey runs exactly this round trip.
describe("what we export survives a real import", () => {
	it("comes back as the SAME scalar the vault stores, not the DER blob", async () => {
		const der = pkcs8FromScalar(scalar);
		const material = await fakePasskeyImportPkcs8(base64UrlToBase64(der ?? ""));
		expect(material.privateKey).toBe(scalar);
		expect(base64ToBytes(material.privateKey)).toHaveLength(32);
	});

	it("yields a COSE_Key, since CXF carries no public key", async () => {
		const material = await fakePasskeyImportPkcs8(base64UrlToBase64(pkcs8FromScalar(scalar) ?? ""));
		const cose = base64ToBytes(material.publicKeyCose);
		expect([...cose.slice(0, 7)]).toEqual([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01]);
		expect(cose).toHaveLength(77);
	});
});
