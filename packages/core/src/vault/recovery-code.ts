// Recovery code generation + normalization.
// WARNING: every wrap/unwrap call site MUST normalizeRecoveryCode() first so a
// code typed back with different casing/spacing/lookalikes still matches.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

const GROUP = 5;
const GROUPS = 6; // 30 chars × 5 bits = 150 bits of entropy

/** Generate a 150-bit recovery code, grouped as XXXXX-XXXXX-...-XXXXX. */
export function generateRecoveryCode(): string {
	const chars = GROUP * GROUPS;
	const bytes = new Uint8Array(chars);
	globalThis.crypto.getRandomValues(bytes);
	let out = "";
	// & 0x1f spans exactly [0,32) so no modulo bias
	for (let i = 0; i < bytes.length; i++) out += ALPHABET[bytes[i]! & 0x1f];
	return out.match(/.{1,5}/g)!.join("-");
}

/** Canonicalize a code for the KDF: strip separators, uppercase, fold Crockford lookalikes (O to 0, I/L to 1). */
export function normalizeRecoveryCode(input: string): string {
	return input
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, "")
		.replace(/O/g, "0")
		.replace(/[IL]/g, "1");
}
