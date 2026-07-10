import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../../util/bytes";
import { CHUNK_BYTES, chunkUtf8, recvSecure, type SecureWasm, sendSecure } from "./secure-channel";

// An identity "Noise" transport: ciphertext = base64(utf8(plaintext)). Base64 never
// begins with '{', so it stands in for a real Noise frame vs. the JSON multi-frame
// wrapper, and round-trips exactly. sessionId is ignored (single logical session).
const dec = new TextDecoder();
const enc = new TextEncoder();
const fakeWasm: SecureWasm = {
	handshake_encrypt: (_sid, pt) => bytesToBase64(enc.encode(pt)),
	handshake_decrypt: (_sid, ct) => dec.decode(base64ToBytes(ct)),
};

/** Collect what sendSecure puts on the wire, and replay it (or a tweaked copy) to recvSecure. */
function wire() {
	const sent: string[] = [];
	return {
		channel: { send: (d: string) => void sent.push(d) },
		sent,
		/** A recvOne that yields the given frames in order, then null (channel closed). */
		reader: (frames: string[] = sent) => {
			let i = 0;
			return () => Promise.resolve(i < frames.length ? frames[i++]! : null);
		},
	};
}

describe("chunkUtf8", () => {
	it("returns the whole string as one part when it fits", () => {
		expect(chunkUtf8("hello", 1024)).toEqual(["hello"]);
	});

	it("splits into <= maxBytes byte pieces that rejoin to the original", () => {
		const s = "a".repeat(1000);
		const parts = chunkUtf8(s, 256);
		expect(parts.length).toBe(4);
		for (const p of parts) expect(enc.encode(p).length).toBeLessThanOrEqual(256);
		expect(parts.join("")).toBe(s);
	});

	it("never splits a multibyte codepoint", () => {
		// "😀" is 4 UTF-8 bytes; a naive byte cut at 2 would corrupt it.
		const s = "😀".repeat(50); // 200 bytes
		const parts = chunkUtf8(s, 10); // 10 bytes -> 2 emoji per part (8 bytes), boundary safe
		for (const p of parts) {
			expect(enc.encode(p).length).toBeLessThanOrEqual(10);
			expect(p).not.toContain("�"); // no replacement char from a cut codepoint
		}
		expect(parts.join("")).toBe(s);
	});
});

describe("sendSecure / recvSecure round-trip", () => {
	it("sends a small payload as a single legacy frame (bare ciphertext, no framing)", async () => {
		const w = wire();
		await sendSecure(w.channel, fakeWasm, 1, "small payload");
		expect(w.sent).toHaveLength(1);
		expect(w.sent[0]!.startsWith("{")).toBe(false); // legacy raw base64, wire-compatible
		expect(await recvSecure(w.reader(), fakeWasm, 1)).toBe("small payload");
	});

	it("chunks a payload larger than one Noise frame and reassembles it exactly", async () => {
		const payload = "x".repeat(CHUNK_BYTES * 3 + 123);
		const w = wire();
		await sendSecure(w.channel, fakeWasm, 1, payload);
		expect(w.sent.length).toBe(4); // ceil((3*CHUNK+123)/CHUNK)
		for (const [i, msg] of w.sent.entries()) {
			const f = JSON.parse(msg);
			expect(f).toMatchObject({ i, n: 4 });
			expect(typeof f.c).toBe("string");
		}
		expect(await recvSecure(w.reader(), fakeWasm, 1)).toBe(payload);
	});

	it("round-trips a large multibyte payload without corruption", async () => {
		const payload = "🔐café—日本語 ".repeat(CHUNK_BYTES / 4); // well over one frame, multibyte
		const w = wire();
		await sendSecure(w.channel, fakeWasm, 1, payload);
		expect(w.sent.length).toBeGreaterThan(1);
		expect(await recvSecure(w.reader(), fakeWasm, 1)).toBe(payload);
	});

	it("returns null when the channel closes mid-message (aborted reassembly)", async () => {
		const w = wire();
		await sendSecure(w.channel, fakeWasm, 1, "y".repeat(CHUNK_BYTES * 2));
		expect(w.sent.length).toBe(2);
		// Deliver only the first frame, then close.
		expect(await recvSecure(w.reader([w.sent[0]!]), fakeWasm, 1)).toBeNull();
	});

	it("throws on a dropped or out-of-order continuation frame (Noise can't reorder)", async () => {
		const w = wire();
		await sendSecure(w.channel, fakeWasm, 1, "z".repeat(CHUNK_BYTES * 3));
		expect(w.sent.length).toBe(3);
		const reordered = [w.sent[0]!, w.sent[2]!, w.sent[1]!]; // frame 2 before frame 1
		await expect(recvSecure(w.reader(reordered), fakeWasm, 1)).rejects.toThrow(/expected frame 1/);
	});
});
