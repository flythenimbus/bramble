import { describe, expect, it } from "vitest";
import { decideLock } from "./auto-lock-decision";

const MIN = 60_000;

describe("decideLock", () => {
	it("never locks when the timeout is 'Never' (0)", () => {
		for (const reason of ["idle", "left", "returned"] as const) {
			expect(decideLock(reason, 0, 999 * MIN, false).lock).toBe(false);
		}
	});

	describe("'Immediately' (-1)", () => {
		it("locks on leaving and on returning, but not on an idle tick", () => {
			expect(decideLock("left", -1, 0, false).lock).toBe(true);
			expect(decideLock("returned", -1, 0, false).lock).toBe(true);
			expect(decideLock("idle", -1, 999 * MIN, false).lock).toBe(false);
		});

		// The bug: opening a file picker backgrounds the app, which used to lock the
		// vault mid-import. With the grace armed, the leave/return cycle is skipped.
		it("skips the leave/return lock while a file pick is in flight", () => {
			expect(decideLock("left", -1, 0, true)).toMatchObject({ lock: false });
			const returned = decideLock("returned", -1, 0, true);
			expect(returned.lock).toBe(false);
			expect(returned.consumeGrace).toBe(true); // cleared once we're back
		});

		it("does not consume the grace merely on leaving", () => {
			expect(decideLock("left", -1, 0, true).consumeGrace).toBe(false);
		});
	});

	describe("positive idle timeout", () => {
		it("locks only once the idle time reaches the timeout", () => {
			expect(decideLock("idle", 15, 14 * MIN, false).lock).toBe(false);
			expect(decideLock("idle", 15, 15 * MIN, false).lock).toBe(true);
			expect(decideLock("returned", 15, 20 * MIN, false).lock).toBe(true);
		});

		it("treats the picker detour as activity while the grace is active", () => {
			const d = decideLock("returned", 15, 99 * MIN, true);
			expect(d.lock).toBe(false);
			expect(d.bumpActivity).toBe(true);
		});
	});
});
