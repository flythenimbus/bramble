import { describe, expect, it } from "vitest";
import { intervalMs, isDue, retryDelayMs, selectDueTargets } from "./schedule";

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const NOW = 1_700_000_000_000;

describe("backup schedule", () => {
	it("off is never due", () => {
		expect(isDue({ frequency: "off", lastBackupAt: 0 }, NOW)).toBe(false);
	});

	it("a never-backed-up target is due", () => {
		expect(isDue({ frequency: "daily" }, NOW)).toBe(true);
	});

	it("respects the interval per frequency", () => {
		expect(isDue({ frequency: "daily", lastBackupAt: NOW - DAY + 1 }, NOW)).toBe(false);
		expect(isDue({ frequency: "daily", lastBackupAt: NOW - DAY }, NOW)).toBe(true);
		expect(isDue({ frequency: "weekly", lastBackupAt: NOW - 6 * DAY }, NOW)).toBe(false);
		expect(isDue({ frequency: "weekly", lastBackupAt: NOW - 7 * DAY }, NOW)).toBe(true);
	});

	it("intervalMs matches the frequency", () => {
		expect(intervalMs("daily")).toBe(DAY);
		expect(intervalMs("weekly")).toBe(7 * DAY);
		expect(intervalMs("monthly")).toBe(30 * DAY);
		expect(intervalMs("off")).toBe(Number.POSITIVE_INFINITY);
	});

	it("selectDueTargets keeps due+changed and drops off / not-due / unchanged", () => {
		const targets = [
			{ id: "a", frequency: "daily" as const, lastVaultHash: "OLD" }, // never backed up + changed
			{ id: "b", frequency: "daily" as const, lastBackupAt: NOW - 2 * DAY, lastVaultHash: "CUR" }, // due but unchanged
			{ id: "c", frequency: "off" as const, lastVaultHash: "OLD" }, // off
			{ id: "d", frequency: "weekly" as const, lastBackupAt: NOW - DAY, lastVaultHash: "OLD" }, // not due yet
		];
		expect(selectDueTargets(targets, NOW, "CUR").map((t) => t.id)).toEqual(["a"]);
	});
});

describe("retry backoff", () => {
	it("doubles from fifteen minutes", () => {
		expect(retryDelayMs(1, "daily")).toBe(15 * MIN);
		expect(retryDelayMs(2, "daily")).toBe(30 * MIN);
		expect(retryDelayMs(3, "daily")).toBe(60 * MIN);
		expect(retryDelayMs(4, "daily")).toBe(120 * MIN);
	});

	it("never delays past the target's own frequency", () => {
		// The whole point of the cap: a daily target keeps backing up daily however long it has
		// been failing, rather than the doubling turning it into a weekly one.
		expect(retryDelayMs(99, "daily")).toBe(DAY);
		expect(retryDelayMs(99, "weekly")).toBe(7 * DAY);
		// 2 ** 998 is Infinity, and the cap is what survives Math.min.
		expect(retryDelayMs(999, "monthly")).toBe(30 * DAY);
	});

	it("is zero before anything has failed", () => {
		expect(retryDelayMs(0, "daily")).toBe(0);
	});

	// The regression this exists for: a failure leaves lastBackupAt alone, so isDue stayed true
	// and the desktop's five-minute tick retried a wrong password twelve times an hour forever.
	it("holds a failing target off until the delay elapses", () => {
		const failing = { frequency: "daily" as const, failures: 1, failedAt: NOW - 14 * MIN };
		expect(isDue(failing, NOW)).toBe(false);
		expect(isDue({ ...failing, failedAt: NOW - 15 * MIN }, NOW)).toBe(true);
	});

	it("holds it off for longer each time", () => {
		const at = (failures: number, ago: number) => ({
			frequency: "daily" as const,
			failures,
			failedAt: NOW - ago,
		});
		expect(isDue(at(3, 59 * MIN), NOW)).toBe(false);
		expect(isDue(at(3, 61 * MIN), NOW)).toBe(true);
	});

	it("still refuses an off target, backoff or not", () => {
		expect(isDue({ frequency: "off", failures: 1, failedAt: NOW - DAY }, NOW)).toBe(false);
	});

	it("treats a backwards clock as no backoff rather than parking the target", () => {
		// failedAt in the future means the clock moved; waiting it out could be months.
		expect(isDue({ frequency: "daily", failures: 4, failedAt: NOW + DAY }, NOW)).toBe(true);
	});

	it("ignores a failure count with no timestamp", () => {
		expect(isDue({ frequency: "daily", failures: 3 }, NOW)).toBe(true);
	});

	it("keeps a backed-off target out of selectDueTargets", () => {
		const targets = [
			{ id: "ok", frequency: "daily" as const, lastVaultHash: "OLD" },
			{
				id: "failing",
				frequency: "daily" as const,
				lastVaultHash: "OLD",
				failures: 2,
				failedAt: NOW - MIN,
			},
		];
		expect(selectDueTargets(targets, NOW, "CUR").map((t) => t.id)).toEqual(["ok"]);
	});
});
