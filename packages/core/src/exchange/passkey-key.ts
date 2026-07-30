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

import { base64ToBytes, base64UrlToBytes, bytesToBase64, bytesToBase64Url } from "../util/bytes";

/** COSE alg for ES256, the only algorithm our provider mints. */
export const COSE_ES256 = -7;

const P256_COORD_LEN = 32;

/**
 * PKCS#8 PrivateKeyInfo prefix for a P-256 key whose ECPrivateKey carries only the scalar
 * (RFC 5915 makes the public key OPTIONAL, and the curve is already named here):
 *
 *   SEQUENCE(65) { INTEGER 0,
 *                  SEQUENCE(19) { OID 1.2.840.10045.2.1, OID 1.2.840.10045.3.1.7 },
 *                  OCTET STRING(39) { SEQUENCE(37) { INTEGER 1, OCTET STRING(32) <scalar> } } }
 *
 * We store the bare 32-byte scalar (core-rust: `B64.encode(secret.to_bytes())`), while CXF's
 * `key` is PKCS#8 DER, so the two have to be bridged in both directions.
 */
const PKCS8_P256_PREFIX = new Uint8Array([
	0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
	0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01,
	0x01, 0x04, 0x20,
]);

/**
 * Wrap our stored raw P-256 scalar (standard base64) as the base64url PKCS#8 that CXF wants.
 * Returns null unless the input really is a 32-byte scalar, so a malformed passkey is skipped
 * with a warning instead of exported as something no importer can use.
 */
export function pkcs8FromScalar(scalarB64: string): string | null {
	let scalar: Uint8Array;
	try {
		scalar = base64ToBytes(scalarB64);
	} catch {
		return null;
	}
	if (scalar.length !== P256_COORD_LEN) return null;
	const der = new Uint8Array(PKCS8_P256_PREFIX.length + P256_COORD_LEN);
	der.set(PKCS8_P256_PREFIX, 0);
	der.set(scalar, PKCS8_P256_PREFIX.length);
	return bytesToBase64Url(der);
}

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

/** A passkey's key material in the shape the vault stores: both STANDARD base64. */
export interface PasskeyKeyMaterial {
	/** Raw 32-byte P-256 scalar, which is what core-rust signs with. */
	privateKey: string;
	/** COSE_Key rebuilt from the private key, since CXF carries no public key. */
	publicKeyCose: string;
}

/**
 * Unpack CXF's base64url PKCS#8 into what the vault stores. Returns null for anything that
 * isn't an importable P-256 key, so the caller can warn and skip that one passkey instead of
 * failing the whole import.
 *
 * Storing the PKCS#8 verbatim would be a silent corruption: it decodes and looks fine, but
 * `SecretKey::from_slice` in core-rust wants the bare scalar and every later assertion fails.
 */
export async function keyMaterialFromPkcs8(keyB64Url: string): Promise<PasskeyKeyMaterial | null> {
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
		const d = coord(jwk.d);
		if (!x || !y || !d) return null;
		return { privateKey: bytesToBase64(d), publicKeyCose: bytesToBase64(coseEc2Key(x, y)) };
	} catch {
		return null;
	}
}
