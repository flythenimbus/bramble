// Bridging CXF's PKCS#8 against the bare P-256 scalar the vault stores.
//
// Only the EXPORT direction lives here, and only because it is structural: wrapping a scalar
// in a fixed DER header parses nothing and does no curve maths. The IMPORT direction needs a
// real key parse plus a canonical COSE encoding, so it goes through the Rust core
// (`passkey_import_pkcs8`), which is the same code path that mints passkeys and therefore
// cannot drift from it. See docs/credential-exchange.md.

import { base64ToBytes, bytesToBase64Url } from "../util/bytes";

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
