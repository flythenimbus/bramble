import { beforeAll, describe, expect, it } from "vitest";
import { base64ToBytes, base64UrlToBytes, bytesToBase64 } from "../util/bytes";
import { keyMaterialFromPkcs8, pkcs8FromScalar } from "./passkey-key";

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

describe("keyMaterialFromPkcs8", () => {
	it("unpacks back to the SAME scalar the vault stores, not the DER blob", async () => {
		const der = pkcs8FromScalar(scalar);
		const material = await keyMaterialFromPkcs8(der ?? "");
		expect(material?.privateKey).toBe(scalar);
		expect(base64ToBytes(material?.privateKey ?? "")).toHaveLength(32);
	});

	it("rebuilds a COSE_Key, since CXF carries no public key", async () => {
		const material = await keyMaterialFromPkcs8(pkcs8FromScalar(scalar) ?? "");
		const cose = base64ToBytes(material?.publicKeyCose ?? "");
		expect([...cose.slice(0, 7)]).toEqual([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01]);
		expect(cose).toHaveLength(77);
	});

	it("returns null for a key we can't read, so one bad passkey doesn't fail the import", async () => {
		expect(await keyMaterialFromPkcs8("AQID")).toBeNull();
	});
});
