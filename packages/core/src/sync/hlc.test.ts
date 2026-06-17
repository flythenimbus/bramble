import { describe, expect, it } from "vitest";
import {
	compareHlc,
	formatHlc,
	type Hlc,
	HLC_MAX_DRIFT_MS,
	HybridClock,
	maxHlc,
	parseHlc,
} from "./hlc";

const h = (wall: number, counter: number, node: string): Hlc => ({ wall, counter, node });

/** A controllable time source for deterministic tests. */
function fakeTime(start = 1000) {
	let t = start;
	return {
		now: () => t,
		set: (v: number) => {
			t = v;
		},
		advance: (d: number) => {
			t += d;
		},
	};
}

describe("compareHlc", () => {
	it("orders by wall first", () => {
		expect(compareHlc(h(1, 9, "z"), h(2, 0, "a"))).toBe(-1);
		expect(compareHlc(h(2, 0, "a"), h(1, 9, "z"))).toBe(1);
	});

	it("breaks wall ties by counter", () => {
		expect(compareHlc(h(5, 0, "z"), h(5, 1, "a"))).toBe(-1);
	});

	it("breaks counter ties by node", () => {
		expect(compareHlc(h(5, 1, "a"), h(5, 1, "b"))).toBe(-1);
		expect(compareHlc(h(5, 1, "b"), h(5, 1, "a"))).toBe(1);
	});

	it("is zero for identical stamps", () => {
		expect(compareHlc(h(5, 1, "a"), h(5, 1, "a"))).toBe(0);
	});

	it("maxHlc returns the greater", () => {
		expect(maxHlc(h(1, 0, "a"), h(2, 0, "a"))).toEqual(h(2, 0, "a"));
		expect(maxHlc(h(2, 0, "a"), h(1, 0, "a"))).toEqual(h(2, 0, "a"));
	});
});

describe("format/parse", () => {
	it("round-trips", () => {
		const stamp = h(1717000000000, 3, "laptop");
		expect(parseHlc(formatHlc(stamp))).toEqual(stamp);
	});

	it("preserves a node id containing colons and dashes", () => {
		const stamp = h(42, 7, "550e8400-e29b:41d4-a716-446655440000");
		expect(parseHlc(formatHlc(stamp))).toEqual(stamp);
	});

	it("rejects malformed strings", () => {
		expect(() => parseHlc("nope")).toThrow();
		expect(() => parseHlc("1:2:")).toThrow();
		expect(() => parseHlc("-1:0:a")).toThrow();
	});
});

describe("HybridClock.send", () => {
	it("requires a node id", () => {
		expect(() => new HybridClock("")).toThrow();
	});

	it("bumps the counter within the same millisecond", () => {
		const time = fakeTime(1000);
		const clock = new HybridClock("dev", time.now);
		expect(clock.send()).toEqual(h(1000, 0, "dev"));
		expect(clock.send()).toEqual(h(1000, 1, "dev"));
		expect(clock.send()).toEqual(h(1000, 2, "dev"));
	});

	it("resets the counter when wall time advances", () => {
		const time = fakeTime(1000);
		const clock = new HybridClock("dev", time.now);
		clock.send();
		clock.send();
		time.advance(5);
		expect(clock.send()).toEqual(h(1005, 0, "dev"));
	});

	it("does not go backwards when the physical clock does", () => {
		const time = fakeTime(1000);
		const clock = new HybridClock("dev", time.now);
		expect(clock.send()).toEqual(h(1000, 0, "dev"));
		time.set(900); // clock skew backwards
		expect(clock.send()).toEqual(h(1000, 1, "dev"));
	});

	it("produces strictly increasing stamps", () => {
		const time = fakeTime(1000);
		const clock = new HybridClock("dev", time.now);
		let prev = clock.send();
		for (let i = 0; i < 50; i++) {
			if (i % 3 === 0) time.advance(1);
			const next = clock.send();
			expect(compareHlc(next, prev)).toBe(1);
			prev = next;
		}
	});
});

describe("HybridClock.receive", () => {
	it("advances past a remote stamp from the future", () => {
		const time = fakeTime(1000);
		const clock = new HybridClock("dev", time.now);
		const out = clock.receive(h(5000, 2, "other"));
		expect(out.wall).toBe(5000);
		expect(out.counter).toBe(3);
		expect(out.node).toBe("dev");
	});

	it("keeps causality: a later local send beats the witnessed remote", () => {
		const time = fakeTime(1000);
		const clock = new HybridClock("dev", time.now);
		const remote = h(5000, 0, "other");
		clock.witness(remote);
		const local = clock.send();
		expect(compareHlc(local, remote)).toBe(1);
	});

	it("uses physical time when it leads both clocks", () => {
		const time = fakeTime(9000);
		const clock = new HybridClock("dev", time.now);
		const out = clock.receive(h(5000, 4, "other"));
		expect(out).toEqual(h(9000, 0, "dev"));
	});

	it("clamps a remote wall implausibly far in the future", () => {
		const time = fakeTime(1000);
		const clock = new HybridClock("dev", time.now);
		const out = clock.receive(h(Number.MAX_SAFE_INTEGER, 0, "evil"));
		// Bounded to physical time + max drift, not dragged to the far future.
		expect(out.wall).toBe(1000 + HLC_MAX_DRIFT_MS);
		// A later honest send stays at real time, so the poisoned stamp can't keep winning.
		time.set(1000 + HLC_MAX_DRIFT_MS + 1);
		expect(clock.send().wall).toBe(1000 + HLC_MAX_DRIFT_MS + 1);
	});
});
