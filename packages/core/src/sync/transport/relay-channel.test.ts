import { describe, expect, it } from "vitest";
import {
	chunkMessage,
	MAX_CHUNK,
	makeReassembler,
	padMessage,
	unpadMessage,
} from "./relay-channel";

describe("relay-channel chunking", () => {
	it("emits one frame for a small message", () => {
		expect(chunkMessage(0, "hello")).toEqual([{ msgId: 0, idx: 0, total: 1, chunk: "hello" }]);
	});

	it("emits one frame for an empty message", () => {
		expect(chunkMessage(3, "")).toEqual([{ msgId: 3, idx: 0, total: 1, chunk: "" }]);
	});

	it("splits a large message into MAX_CHUNK frames that concatenate back", () => {
		const data = "x".repeat(MAX_CHUNK * 2 + 100);
		const frames = chunkMessage(7, data);
		expect(frames).toHaveLength(3);
		expect(frames.every((f) => f.msgId === 7 && f.total === 3)).toBe(true);
		expect(frames.map((f) => f.chunk).join("")).toBe(data);
	});
});

describe("relay-channel reassembly", () => {
	it("delivers a single-frame message once", () => {
		const got: string[] = [];
		makeReassembler((m) => got.push(m))({ msgId: 0, idx: 0, total: 1, chunk: "hi" });
		expect(got).toEqual(["hi"]);
	});

	it("reassembles out-of-order chunks", () => {
		const data = `${"a".repeat(MAX_CHUNK)}${"b".repeat(MAX_CHUNK)}c`;
		const got: string[] = [];
		const push = makeReassembler((m) => got.push(m));
		for (const f of chunkMessage(1, data).reverse()) push(f);
		expect(got).toEqual([data]);
	});

	it("ignores duplicate chunks and delivers once", () => {
		const frames = chunkMessage(2, "z".repeat(MAX_CHUNK + 5));
		const [f0, f1] = frames;
		if (!f0 || !f1) throw new Error("expected 2 frames");
		const got: string[] = [];
		const push = makeReassembler((m) => got.push(m));
		push(f0);
		push(f0); // dup before complete
		push(f1);
		push(f1); // dup after complete
		expect(got).toEqual([frames.map((f) => f.chunk).join("")]);
	});

	it("interleaves two messages keyed by msgId", () => {
		const a = "A".repeat(MAX_CHUNK + 1);
		const b = "B".repeat(MAX_CHUNK + 1);
		const [a0, a1] = chunkMessage(10, a);
		const [b0, b1] = chunkMessage(11, b);
		if (!a0 || !a1 || !b0 || !b1) throw new Error("expected 2 frames each");
		const got: string[] = [];
		const push = makeReassembler((m) => got.push(m));
		push(a0);
		push(b0);
		push(a1);
		push(b1);
		expect(new Set(got)).toEqual(new Set([a, b]));
	});
});

describe("relay-channel padding", () => {
	it("round-trips arbitrary messages", () => {
		for (const s of ["", "hi", "z".repeat(1000), `${"a".repeat(50000)}\n\t"quoted"`]) {
			expect(unpadMessage(padMessage(s))).toBe(s);
		}
	});

	it("buckets similar lengths to the same padded total", () => {
		expect(padMessage("x".repeat(100)).length).toBe(padMessage("x".repeat(120)).length);
	});

	it("never pads below the input length", () => {
		const s = "y".repeat(777);
		expect(padMessage(s).length).toBeGreaterThanOrEqual(s.length);
	});

	it("survives a chunk round-trip through the transport", () => {
		const data = "m".repeat(MAX_CHUNK * 2 + 500);
		const got: string[] = [];
		const push = makeReassembler((padded) => got.push(unpadMessage(padded)));
		for (const f of chunkMessage(0, padMessage(data))) push(f);
		expect(got).toEqual([data]);
	});
});
