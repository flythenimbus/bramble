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

export function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

export const hexToBase64 = (hex: string): string => bytesToBase64(hexToBytes(hex));
export const base64ToHex = (b64: string): string => bytesToHex(base64ToBytes(b64));
