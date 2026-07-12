import { describe, expect, it } from "vitest";
import { intervalMs, isDue, selectDueTargets } from "./schedule";

const DAY = 24 * 60 * 60 * 1000;
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
