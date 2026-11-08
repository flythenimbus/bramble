import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	invoked: [] as string[],
	listeners: new Map<string, () => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: async (cmd: string) => {
		h.invoked.push(cmd);
	},
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: async (name: string, cb: () => void) => {
		h.listeners.set(name, cb);
		return () => h.listeners.delete(name);
	},
}));

const { reportActivity, startAutoLock } = await import("./auto-lock");
const { onExternalLock, onVaultStateChange } = await import("./adapters/vault-session");

beforeEach(() => {
	vi.useFakeTimers();
	h.invoked.length = 0;
	h.listeners.clear();
});
afterEach(() => vi.useRealTimers());

describe("reportActivity", () => {
	it("tells the shell about input, at most once per 10 seconds", () => {
		const page = new EventTarget();
		const stop = reportActivity(page);
		page.dispatchEvent(new Event("keydown"));
		page.dispatchEvent(new Event("pointerdown"));
		expect(h.invoked).toEqual(["autolock_touch"]);

		vi.advanceTimersByTime(10_000);
		page.dispatchEvent(new Event("wheel"));
		expect(h.invoked).toEqual(["autolock_touch", "autolock_touch"]);

		stop();
		vi.advanceTimersByTime(10_000);
		page.dispatchEvent(new Event("keydown"));
		expect(h.invoked).toHaveLength(2);
	});
});

describe("startAutoLock", () => {
	it("turns the shell's auto-lock into an app lock", async () => {
		const states: boolean[] = [];
		const offState = onVaultStateChange((locked) => states.push(locked));
		const relocks = vi.fn();
		const offLock = onExternalLock(relocks);
		const stop = startAutoLock(new EventTarget());
		await vi.waitFor(() => expect(h.listeners.has("vault://auto-locked")).toBe(true));

		h.listeners.get("vault://auto-locked")?.();
		expect(states).toEqual([true]);
		expect(relocks).toHaveBeenCalledTimes(1);

		stop();
		offState();
		offLock();
	});
});
