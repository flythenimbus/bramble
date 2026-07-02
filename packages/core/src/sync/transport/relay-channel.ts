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
