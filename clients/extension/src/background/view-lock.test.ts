import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBackground, TEST_VEK_KEY } from "../test/test-harness";

// "Immediate" auto-lock (pref.autoLockMinutes < 0): the vault locks when the last extension
// view (popup / pop-out / options) closes. Views are modeled by fireConnect(); the debounce
// and pop-out grace timers are driven with fake timers.

const VEK_KEY = TEST_VEK_KEY;
const AUTOLOCK_PREF = "pref.autoLockMinutes";

/** Load the background in the given auto-lock mode and unlock it (caches a session VEK). */
async function unlocked(minutes: number) {
	const bg = await loadBackground({ localSeed: { [AUTOLOCK_PREF]: minutes } });
	await bg.send({ type: "CRYPTO_GENERATE_VEK" });
	return bg;
}

const lockCount = (bg: Awaited<ReturnType<typeof unlocked>>) =>
	bg.state.offscreenCalls.filter((m) => m.type === "CRYPTO_LOCK").length;

describe("view-lock: Immediate mode locks when the last view closes", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("locks the vault when the last view disconnects (mode -1)", async () => {
		const bg = await unlocked(-1);
		expect(bg.state.session[VEK_KEY]).toBe("VEK_GENERATED");
		bg.fireConnect().disconnect();
		await vi.advanceTimersByTimeAsync(300);
		expect(bg.state.session[VEK_KEY]).toBeUndefined();
		expect(lockCount(bg)).toBe(1);
	});

	it("does not lock in a timed mode (15 minutes)", async () => {
		const bg = await unlocked(15);
		bg.fireConnect().disconnect();
		await vi.advanceTimersByTimeAsync(1000);
		expect(bg.state.session[VEK_KEY]).toBe("VEK_GENERATED");
	});

	it("does not lock in Never mode (0)", async () => {
		const bg = await unlocked(0);
		bg.fireConnect().disconnect();
		await vi.advanceTimersByTimeAsync(1000);
		expect(bg.state.session[VEK_KEY]).toBe("VEK_GENERATED");
	});

	it("locks only after the last of several open views closes", async () => {
		const bg = await unlocked(-1);
		const a = bg.fireConnect();
		const b = bg.fireConnect();
		a.disconnect();
		await vi.advanceTimersByTimeAsync(300);
		expect(bg.state.session[VEK_KEY]).toBe("VEK_GENERATED"); // b is still open
		b.disconnect();
		await vi.advanceTimersByTimeAsync(300);
		expect(bg.state.session[VEK_KEY]).toBeUndefined();
	});

	it("a view reopening before the debounce cancels the pending lock", async () => {
		const bg = await unlocked(-1);
		bg.fireConnect().disconnect();
		bg.fireConnect(); // reopened immediately, stays open
		await vi.advanceTimersByTimeAsync(1000);
		expect(bg.state.session[VEK_KEY]).toBe("VEK_GENERATED");
	});

	it("ignores ports that aren't view ports", async () => {
		const bg = await unlocked(-1);
		bg.fireConnect("some-other-port").disconnect();
		await vi.advanceTimersByTimeAsync(1000);
		expect(bg.state.session[VEK_KEY]).toBe("VEK_GENERATED");
	});

	it("is a no-op when the vault is already locked (no offscreen spin-up)", async () => {
		const bg = await loadBackground({ localSeed: { [AUTOLOCK_PREF]: -1 } }); // never unlocked
		bg.fireConnect().disconnect();
		await vi.advanceTimersByTimeAsync(300);
		expect(lockCount(bg)).toBe(0);
	});

	it("armViewGrace bridges the popup -> pop-out handoff without locking", async () => {
		const bg = await unlocked(-1);
		const { armViewGrace } = await import("../background/view-lock");
		const popup = bg.fireConnect();
		armViewGrace(); // a pop-out was requested
		popup.disconnect(); // popup closes a beat before the detached window connects
		await vi.advanceTimersByTimeAsync(2000); // past the close debounce, still inside the grace
		expect(bg.state.session[VEK_KEY]).toBe("VEK_GENERATED"); // held open across the handoff
		const detached = bg.fireConnect(); // detached window connects
		await vi.advanceTimersByTimeAsync(9000); // past the grace
		expect(bg.state.session[VEK_KEY]).toBe("VEK_GENERATED"); // a view is open, so no lock
		detached.disconnect();
		await vi.advanceTimersByTimeAsync(300);
		expect(bg.state.session[VEK_KEY]).toBeUndefined(); // now the vault locks
	});
});
