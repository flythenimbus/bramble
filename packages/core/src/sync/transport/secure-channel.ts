// Frames an authenticated Noise session's app-data phase so a payload larger than
// one Noise transport frame can cross the channel. A single Noise frame is capped
// at 64 KiB (core-rust MAX_MSG); the whole vault bundle / sync envelope exceeds that
// once a vault holds more than a few dozen entries, which surfaced as
// "message too large for one Noise frame". sendSecure splits the plaintext into
// frame-sized chunks, encrypts each into its own Noise frame, and sends each as one
// Channel message; recvSecure reassembles. Each frame is also small enough to stay
// under the WebRTC data-channel max-message-size (webrtc-peer sends unchunked), so
// this one seam covers both ceilings. See docs/p2p-sync.md.

import type { Channel } from "./channel";
import type { Awaitable } from "./handshake";

// Plaintext bytes per Noise frame. Kept well under MAX_MSG (65535 - 16 tag) so the
// frame fits, and small enough that the base64 ciphertext (~1.34x -> ~43 KiB) stays
// under the smallest SCTP max-message-size we target across Chrome and webrtc-rs.
export const CHUNK_BYTES = 32 * 1024;

/** The Noise app-data slice both enrollment and roster-sync already expose. Returns are
 * Awaitable so the in-webview WASM (sync) and the native plugin (async bridge) share it. */
export interface SecureWasm {
	handshake_encrypt(sessionId: number, plaintext: string): Awaitable<string>;
	handshake_decrypt(sessionId: number, ciphertextB64: string): Awaitable<string>;
}

// One frame of a multi-frame message. Sent as JSON; the leading '{' distinguishes it
// from a legacy single-frame message, whose body is a raw base64 ciphertext (the
// base64 alphabet never begins with '{'). Kept terse since it rides every frame.
interface Frame {
	/** 0-based index within the message. */
	i: number;
	/** total frame count. */
	n: number;
	/** base64 Noise ciphertext of this chunk. */
	c: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Split a string into pieces each at most `maxBytes` UTF-8 bytes, never cutting a
 * codepoint (a continuation byte is 0b10xxxxxx). Returns [str] when it already fits. */
export function chunkUtf8(str: string, maxBytes: number): string[] {
	const bytes = encoder.encode(str);
	if (bytes.length <= maxBytes) return [str];
	const parts: string[] = [];
	for (let start = 0; start < bytes.length; ) {
		let end = Math.min(start + maxBytes, bytes.length);
		// Back off to a codepoint boundary so the chunk decodes cleanly (no-op at buffer end).
		while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80 && end > start) end--;
		parts.push(decoder.decode(bytes.subarray(start, end)));
		start = end;
	}
	return parts;
}

function parseFrame(raw: string): Frame | null {
	if (raw.charCodeAt(0) !== 0x7b /* { */) return null; // legacy raw-ciphertext frame
	try {
		const o = JSON.parse(raw) as Partial<Frame>;
		if (typeof o.i === "number" && typeof o.n === "number" && typeof o.c === "string") {
			return o as Frame;
		}
	} catch {
		// Not our frame JSON; fall through.
	}
	return null;
}

/**
 * Encrypt `plaintext` over the session and send it, chunked into Noise-frame-sized
 * pieces when needed. A single-chunk payload is sent as a bare base64 ciphertext,
 * byte-identical to the pre-chunking wire format, so an un-updated peer still
 * interoperates on small vaults (a vault too big for one frame could never sync with
 * such a peer anyway). Frames go out in order; Noise's transport nonce requires the
 * receiver to decrypt them in that same order.
 */
export async function sendSecure(
	channel: Pick<Channel, "send">,
	wasm: SecureWasm,
	sessionId: number,
	plaintext: string,
): Promise<void> {
	const chunks = chunkUtf8(plaintext, CHUNK_BYTES);
	if (chunks.length === 1) {
		channel.send(await wasm.handshake_encrypt(sessionId, chunks[0]!));
		return;
	}
	const n = chunks.length;
	for (let i = 0; i < n; i++) {
		const c = await wasm.handshake_encrypt(sessionId, chunks[i]!);
		channel.send(JSON.stringify({ i, n, c } satisfies Frame));
	}
}

/**
 * Receive one full message: read frames via `recvOne`, decrypt each in arrival order
 * (Noise transport is order-dependent), and reassemble. `recvOne` returns null when
 * the channel is closed/aborted (roster-sync races recv against reaping); recvSecure
 * then returns null, dropping any partial message. A legacy single-frame message is
 * decrypted and returned directly.
 */
export async function recvSecure(
	recvOne: () => Promise<string | null>,
	wasm: SecureWasm,
	sessionId: number,
): Promise<string | null> {
	const first = await recvOne();
	if (first === null) return null;
	const head = parseFrame(first);
	if (!head) return wasm.handshake_decrypt(sessionId, first);

	let out = await wasm.handshake_decrypt(sessionId, head.c);
	for (let i = 1; i < head.n; i++) {
		const raw = await recvOne();
		if (raw === null) return null;
		const frame = parseFrame(raw);
		// Frames of one message arrive contiguously and in order (serialized sends +
		// in-order transport); anything else means a dropped/interleaved frame, which
		// Noise's nonce order can't recover from.
		if (!frame || frame.i !== i) {
			throw new Error(`secure channel: expected frame ${i}, got ${frame ? frame.i : "non-frame"}`);
		}
		out += await wasm.handshake_decrypt(sessionId, frame.c);
	}
	return out;
}
