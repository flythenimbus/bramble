// Hybrid logical clock (HLC) for vault sync. See docs/p2p-sync.md.
// A stamp is (wall, counter, node), compared in that order. wall keeps stamps
// close to physical time, counter breaks same-millisecond ties on one device,
// and node is the final tiebreaker so the total order is identical on every
// device. receive() advances past observed remote stamps, so causality holds
// even when wall clocks drift.

import { z } from "zod";

/** A hybrid logical clock stamp. */
export interface Hlc {
	/** Physical time in milliseconds. */
	readonly wall: number;
	/** Tiebreaker for events sharing a wall time. */
	readonly counter: number;
	/** Device id; final tiebreaker so the order is identical on every device. */
	readonly node: string;
}

/** Runtime validation for a stamp parsed from an untrusted blob. */
export const HlcSchema = z.object({
	wall: z.number().int().nonnegative(),
	counter: z.number().int().nonnegative(),
	node: z.string().min(1),
});

// Backstop against a runaway loop; far above any real per-millisecond event rate.
const MAX_COUNTER = 0x7fffffff;

// A remote stamp this far ahead of our physical clock is implausible (honest skew
// is far smaller). We clamp it when advancing our clock so a peer can't drag us
// into the far future, which would make all our later stamps win merges they
// shouldn't. The clamp self-heals as physical time passes.
export const HLC_MAX_DRIFT_MS = 5 * 60 * 1000;

/** Compare two stamps. Returns -1, 0, or 1. Total order: wall, then counter, then node. */
export function compareHlc(a: Hlc, b: Hlc): -1 | 0 | 1 {
	if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
	if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
	if (a.node !== b.node) return a.node < b.node ? -1 : 1;
	return 0;
}

/** The greater of two stamps (b on an exact tie, which only happens for equal stamps). */
export function maxHlc(a: Hlc, b: Hlc): Hlc {
	return compareHlc(a, b) >= 0 ? a : b;
}

/** True if a stamp's wall clock is implausibly far ahead of `now` (beyond honest skew).
 * Honest devices clamp their own clock (see receive()), so a real stamp is never this far in
 * the future; a future-dated stamp is poisoned. Remote payloads are filtered by this before
 * merge so a member can't stamp a record years ahead to outrank a later revocation/deletion
 * forever (the tombstone, stamped ~now, would otherwise always lose). */
export function isFutureStamp(hlc: Hlc, now: number = Date.now()): boolean {
	return hlc.wall > now + HLC_MAX_DRIFT_MS;
}

/** Serialize a stamp to `wall:counter:node`. node may itself contain colons. */
export function formatHlc(h: Hlc): string {
	return `${h.wall}:${h.counter}:${h.node}`;
}

/** Parse a stamp from `wall:counter:node`. Splits on the first two colons only. */
export function parseHlc(s: string): Hlc {
	const first = s.indexOf(":");
	const second = s.indexOf(":", first + 1);
	if (first < 0 || second < 0) throw new Error(`invalid HLC string: ${s}`);
	const wall = Number(s.slice(0, first));
	const counter = Number(s.slice(first + 1, second));
	const node = s.slice(second + 1);
	if (!Number.isInteger(wall) || wall < 0) throw new Error(`invalid HLC wall: ${s}`);
	if (!Number.isInteger(counter) || counter < 0) throw new Error(`invalid HLC counter: ${s}`);
	if (node.length === 0) throw new Error(`invalid HLC node: ${s}`);
	return { wall, counter, node };
}

/**
 * A device's hybrid logical clock. send() stamps a local write; receive()
 * advances past an observed remote stamp before stamping. The time source is
 * injectable so tests are deterministic.
 */
export class HybridClock {
	private wall = 0;
	private counter = 0;

	constructor(
		private readonly node: string,
		private readonly now: () => number = () => Date.now(),
	) {
		if (node.length === 0) throw new Error("HybridClock requires a non-empty node id");
	}

	/** Stamp a local write. */
	send(): Hlc {
		const pt = this.now();
		const prevWall = this.wall;
		this.wall = Math.max(prevWall, pt);
		this.counter = this.wall === prevWall ? this.counter + 1 : 0;
		this.guard();
		return { wall: this.wall, counter: this.counter, node: this.node };
	}

	/** Advance past an observed remote stamp, then stamp the receiving event. */
	receive(remote: Hlc): Hlc {
		const pt = this.now();
		const prevWall = this.wall;
		const prevCounter = this.counter;
		// Clamp an implausibly-far-future remote wall (see HLC_MAX_DRIFT_MS) so a peer
		// can't shove our clock past physical time + honest skew.
		const remoteWall = Math.min(remote.wall, pt + HLC_MAX_DRIFT_MS);
		this.wall = Math.max(prevWall, remoteWall, pt);
		if (this.wall === prevWall && this.wall === remoteWall) {
			this.counter = Math.max(prevCounter, remote.counter) + 1;
		} else if (this.wall === prevWall) {
			this.counter = prevCounter + 1;
		} else if (this.wall === remoteWall) {
			this.counter = remote.counter + 1;
		} else {
			this.counter = 0;
		}
		this.guard();
		return { wall: this.wall, counter: this.counter, node: this.node };
	}

	/** Observe a remote stamp without emitting one (e.g. ingesting a batch). */
	witness(remote: Hlc): void {
		this.receive(remote);
	}

	private guard(): void {
		if (this.counter > MAX_COUNTER) {
			throw new Error("HLC counter overflow");
		}
	}
}
