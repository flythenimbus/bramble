// Rebuilding a passkey's public key from the private key CXF carries.
//
// CXF ships only the PKCS#8 private key: no public key, no COSE algorithm. Our
// PasskeyCredential wants `publicKeyCose`, so we derive it. WebCrypto's JWK export of an
// EC private key includes the public coordinates, which is enough to assemble the COSE_Key
// without touching the Rust core (and so this stays a pure-TS, vitest-runnable mapper).
//
// `publicKeyCose` is write-only at runtime today: it is stored at creation and never read
// back for an assertion. So these bytes need to be correct, not byte-identical to what
// coset emits in core-rust/src/passkey.rs.

import { base64UrlToBytes, bytesToBase64 } from "../util/bytes";

/** COSE alg for ES256, the only algorithm our provider mints. */
export const COSE_ES256 = -7;

const P256_COORD_LEN = 32;

/**
 * COSE_Key for an EC2 P-256 public key:
 * {1: 2 (kty EC2), 3: -7 (alg ES256), -1: 1 (crv P-256), -2: x, -3: y}
 * Hand-encoded because the shape is fixed; a CBOR library would be dead weight here.
 */
function coseEc2Key(x: Uint8Array, y: Uint8Array): Uint8Array {
	const out = [
		0xa5, // map(5)
		0x01,
		0x02, // kty: EC2
		0x03,
		0x26, // alg: -7
		0x20,
		0x01, // crv: P-256
		0x21,
		0x58,
		P256_COORD_LEN, // x: bytes(32)
		...x,
		0x22,
		0x58,
		P256_COORD_LEN, // y: bytes(32)
		...y,
	];
	return new Uint8Array(out);
}

/** Left-pad a coordinate to 32 bytes; WebCrypto can hand back a short one. */
function coord(b64url: string | undefined): Uint8Array | null {
	if (!b64url) return null;
	const bytes = base64UrlToBytes(b64url);
	if (bytes.length > P256_COORD_LEN) return null;
	const out = new Uint8Array(P256_COORD_LEN);
	out.set(bytes, P256_COORD_LEN - bytes.length);
	return out;
}

/**
 * Derive the COSE public key (STANDARD base64, matching how the Rust core stores it) from a
 * base64url PKCS#8 private key. Returns null for anything that isn't an importable P-256 key,
 * so the caller can warn and skip that one passkey instead of failing the whole import.
 */
export async function coseFromPkcs8(keyB64Url: string): Promise<string | null> {
	try {
		const key = await crypto.subtle.importKey(
			"pkcs8",
			base64UrlToBytes(keyB64Url) as BufferSource,
			{ name: "ECDSA", namedCurve: "P-256" },
			true,
			["sign"],
		);
		const jwk = await crypto.subtle.exportKey("jwk", key);
		const x = coord(jwk.x);
		const y = coord(jwk.y);
		if (!x || !y) return null;
		return bytesToBase64(coseEc2Key(x, y));
	} catch {
		return null;
	}
}
