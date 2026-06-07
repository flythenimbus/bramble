// Recovery code generation + normalization.
//
//

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

const GROUP = 5;
const GROUPS = 6; // 30 chars × 5 bits = 150 bits of entropy

export function generateRecoveryCode(): string {
	const chars = GROUP * GROUPS;
	const bytes = new Uint8Array(chars);
	globalThis.crypto.getRandomValues(bytes);
	let out = "";
	for (let i = 0; i < bytes.length; i++) out += ALPHABET[bytes[i]! & 0x1f];
	return out.match(/.{1,5}/g)!.join("-");
}

export function normalizeRecoveryCode(input: string): string {
	return input
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, "")
		.replace(/O/g, "0")
		.replace(/[IL]/g, "1");
}
