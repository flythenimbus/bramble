// Relay-forward transport: split a Channel's string messages into relay-sized frames
// and reassemble them, so the relay can carry payloads larger than its per-message cap.
// Used when a peer can't do WebRTC (Firefox, WebRTC disabled, or a data channel that
// won't connect); the relay only ever sees the Noise ciphertext. See
// docs/firefox-port.md "Firefox P2P transport".

// Raw chars per chunk. The relay caps a message at 64 KiB; after group-key encryption
// (base64, ~1.33x) plus the Nostr event envelope, a 32 KiB chunk stays well under that.
export const MAX_CHUNK = 32 * 1024;

export interface DataFrame {
	/** Per-sender message id (a monotonic counter); groups a message's chunks. */
	msgId: number;
	idx: number;
	total: number;
	chunk: string;
}

// --- size padding ---
// The relay sees each frame's (encrypted) length, which would leak roughly how big the
// vault is / how many entries it holds. Pad messages into coarse buckets so the length
// reveals only a range. NIP-44-style: bucket to a step that grows with size, so overhead
// is bounded (~12.5% for large payloads) rather than doubling. Padding is transport-local
// — applied before chunking, stripped after reassembly — so the crypto layer is unaware.

const LEN_HEADER = 8; // hex chars encoding the real (unpadded) data length

/** NIP-44 calc_padded_len: round up to a size-dependent bucket. */
function paddedLen(len: number): number {
	if (len <= 32) return 32;
	const nextPower = 1 << (Math.floor(Math.log2(len - 1)) + 1);
	const step = nextPower <= 256 ? 32 : nextPower / 8;
	return step * (Math.floor((len - 1) / step) + 1);
}

/** Prefix the real length, then pad with filler to the next bucket. */
export function padMessage(data: string): string {
	const header = data.length.toString(16).padStart(LEN_HEADER, "0");
	const total = paddedLen(LEN_HEADER + data.length);
	return header + data + "0".repeat(total - LEN_HEADER - data.length);
}

/** Recover the original message by slicing to the length in the header. */
export function unpadMessage(padded: string): string {
	const len = Number.parseInt(padded.slice(0, LEN_HEADER), 16);
	return padded.slice(LEN_HEADER, LEN_HEADER + len);
}

/** Split one Channel message into ordered frames (always at least one). */
export function chunkMessage(msgId: number, data: string): DataFrame[] {
	const total = Math.max(1, Math.ceil(data.length / MAX_CHUNK));
	const frames: DataFrame[] = [];
	for (let idx = 0; idx < total; idx++) {
		frames.push({ msgId, idx, total, chunk: data.slice(idx * MAX_CHUNK, (idx + 1) * MAX_CHUNK) });
	}
	return frames;
}

/**
 * Buffer frames until a message is complete, then deliver the reassembled string.
 * Tolerates interleaved messages (keyed by msgId), out-of-order chunks, and duplicates.
 */
export function makeReassembler(deliver: (full: string) => void): (frame: DataFrame) => void {
	const pending = new Map<number, { parts: string[]; have: number; total: number }>();
	return (frame) => {
		let entry = pending.get(frame.msgId);
		if (!entry) {
			entry = { parts: new Array<string>(frame.total), have: 0, total: frame.total };
			pending.set(frame.msgId, entry);
		}
		if (frame.idx >= 0 && frame.idx < entry.total && entry.parts[frame.idx] === undefined) {
			entry.parts[frame.idx] = frame.chunk;
			entry.have++;
		}
		if (entry.have === entry.total) {
			pending.delete(frame.msgId);
			deliver(entry.parts.join(""));
		}
	};
}
