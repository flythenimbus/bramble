// Byte <-> base64 / hex conversions. The single home for these; do not re-implement
// them. nostr.ts works in hex (wire format), the wasm + storage in base64.

const HEX = "0123456789abcdef";

export function bytesToBase64(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
	return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
	const s = atob(b64);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

export function bytesToHex(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += HEX[b >> 4]! + HEX[b & 15]!;
	return s;
}

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

export const hexToBase64 = (hex: string): string => bytesToBase64(hexToBytes(hex));
export const base64ToHex = (b64: string): string => bytesToHex(base64ToBytes(b64));

// base64url (RFC 4648 §5, unpadded): the WebAuthn wire encoding. The Rust core and
// storage use STANDARD base64, so these convert at the WebAuthn boundary.
export const base64ToBase64Url = (b64: string): string =>
	b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const base64UrlToBase64 = (b64url: string): string => {
	const rem = b64url.length % 4;
	return b64url.replace(/-/g, "+").replace(/_/g, "/") + (rem ? "=".repeat(4 - rem) : "");
};
export const bytesToBase64Url = (bytes: Uint8Array): string =>
	base64ToBase64Url(bytesToBase64(bytes));
export const base64UrlToBytes = (b64url: string): Uint8Array =>
	base64ToBytes(base64UrlToBase64(b64url));
