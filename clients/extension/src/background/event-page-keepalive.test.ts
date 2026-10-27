import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function stubChrome() {
	const getPlatformInfo = vi.fn(async () => ({ os: "mac" }));
	vi.stubGlobal("chrome", { runtime: { getPlatformInfo } });
	return { getPlatformInfo };
}

// Import after the chrome stub so platform-api binds to it; reset modules so each test's stub sticks.
async function load() {
	vi.resetModules();
	return import("./event-page-keepalive");
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("event-page keepalive", () => {
	it("pings a lightweight API on an interval while active (suspends = true)", async () => {
		const { getPlatformInfo } = stubChrome();
		const { keepEventPageAlive, releaseEventPage } = await load();

		keepEventPageAlive(true, 60_000);
		expect(getPlatformInfo).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(getPlatformInfo).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(getPlatformInfo).toHaveBeenCalledTimes(2);

		releaseEventPage();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(getPlatformInfo).toHaveBeenCalledTimes(2); // stopped
	});

	it("is a no-op when the host doesn't suspend (Chrome)", async () => {
		const { getPlatformInfo } = stubChrome();
		const { keepEventPageAlive } = await load();

		keepEventPageAlive(false);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(getPlatformInfo).not.toHaveBeenCalled();
	});

	it("self-releases after maxMs so a missed release can't keep it awake forever", async () => {
		const { getPlatformInfo } = stubChrome();
		const { keepEventPageAlive } = await load();

		keepEventPageAlive(true, 30_000);
		await vi.advanceTimersByTimeAsync(20_000); // ping at 20s (< 30s deadline)
		expect(getPlatformInfo).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(20_000); // 40s: past deadline -> self-release, no ping
		expect(getPlatformInfo).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(getPlatformInfo).toHaveBeenCalledTimes(1); // stays stopped
	});
});
