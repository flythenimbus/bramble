// A stand-in for the Rust `passkey_import_pkcs8`, for tests only.
//
// Core's tests never load real WASM (see adapters/crypto-wasm.test.ts, which fakes the whole
// module), so the mapper tests need a double. This one does the conversion for real with
// WebCrypto rather than returning canned values, which keeps the round-trip test honest about
// key material: what goes out as PKCS#8 has to come back as the same scalar.
//
// It is NOT a second implementation to keep in sync. Production goes through the Rust core,
// whose own test signs with the converted key; this exists so the TS mapping either side of
// that call can be exercised without a WASM build.

import type { PasskeyImportResult } from "../adapters/crypto";
import type { ImportParserContext } from "../import/types";
import { base64ToBytes, base64UrlToBytes, bytesToBase64 } from "../util/bytes";

const P256_COORD_LEN = 32;

/** Left-pad a JWK coordinate to 32 bytes; WebCrypto can hand back a short one. */
function coord(b64url: string | undefined): Uint8Array {
	const bytes = base64UrlToBytes(b64url ?? "");
	const out = new Uint8Array(P256_COORD_LEN);
	out.set(bytes.slice(0, P256_COORD_LEN), P256_COORD_LEN - Math.min(bytes.length, P256_COORD_LEN));
	return out;
}

/** COSE_Key EC2/P-256: {1: 2, 3: -7, -1: 1, -2: x, -3: y}. */
function coseEc2Key(x: Uint8Array, y: Uint8Array): Uint8Array {
	return new Uint8Array([
		0xa5,
		0x01,
		0x02,
		0x03,
		0x26,
		0x20,
		0x01,
		0x21,
		0x58,
		P256_COORD_LEN,
		...x,
		0x22,
		0x58,
		P256_COORD_LEN,
		...y,
	]);
}

/** Rejects on anything that isn't an importable P-256 key, exactly as the Rust does. */
export async function fakePasskeyImportPkcs8(pkcs8B64: string): Promise<PasskeyImportResult> {
	const key = await crypto.subtle.importKey(
		"pkcs8",
		base64ToBytes(pkcs8B64) as BufferSource,
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign"],
	);
	const jwk = await crypto.subtle.exportKey("jwk", key);
	return {
		privateKey: bytesToBase64(coord(jwk.d)),
		publicKeyCose: bytesToBase64(coseEc2Key(coord(jwk.x), coord(jwk.y))),
	};
}

export const testParserContext: ImportParserContext = {
	passkeyImportPkcs8: fakePasskeyImportPkcs8,
};
