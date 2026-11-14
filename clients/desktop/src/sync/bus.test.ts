import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.useRealTimers();
});

// Issue #230: a log with no times could cover a minute or an hour. The Settings panel usually opens
// long after sync started, so a replayed line must keep the time it was logged, not the replay's.
describe("sync status", () => {
	it("hands over each line with the time it was logged, also to a late subscriber", async () => {
		vi.useFakeTimers({ now: 1_000 });
		vi.resetModules();
		const bus = await import("./bus");
		bus.report("relay connected (relay.example.com)");
		vi.setSystemTime(5_000);

		const seen: [string, number][] = [];
		bus.onSyncStatus((status, at) => seen.push([status, at]));
		bus.report("synced with tG/Lnb18 ✅");

		expect(seen).toEqual([
			["relay connected (relay.example.com)", 1_000],
			["synced with tG/Lnb18 ✅", 5_000],
		]);
	});
});
