// SHA-256 over WebCrypto, available everywhere we run (extension service worker, mobile
// webview), so it needs no Rust. The single home for it; do not re-implement, the way
// util/bytes.ts is the single home for the encodings.

import { bytesToHex } from "./bytes";

const encoder = new TextEncoder();

/** Lowercase hex SHA-256 of bytes, or of a string's UTF-8 encoding. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
	const bytes = typeof data === "string" ? encoder.encode(data) : data;
	const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes) as BufferSource);
	return bytesToHex(new Uint8Array(digest));
}
