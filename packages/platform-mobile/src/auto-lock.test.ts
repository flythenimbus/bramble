// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drive the auto-lock lifecycle wiring by hand: capture the Capacitor App listeners
// and the adapter calls so we can replay the exact background→foreground sequence a
// native file picker causes, and assert whether the vault locks.
const { handlers, isLocked, getMeta, lockForLifecycle } = vi.hoisted(() => ({
	handlers: {} as Record<string, (arg?: unknown) => void>,
	isLocked: vi.fn(),
	getMeta: vi.fn(),
	lockForLifecycle: vi.fn(),
}));

vi.mock("@capacitor/app", () => ({
	App: {
		addListener: (event: string, cb: (arg?: unknown) => void) => {
			handlers[event] = cb;
			return Promise.resolve({
				remove: () => {
					delete handlers[event];
				},
			});
		},
	},
}));
vi.mock("./adapters/crypto", () => ({ mobileCrypto: { isLocked } }));
vi.mock("./adapters/storage", () => ({ mobileStorage: { getMeta } }));
vi.mock("./adapters/vault-session", () => ({ lockForLifecycle }));
vi.mock("@core/hooks/usePrefs", () => ({
	DEFAULT_AUTOLOCK_MINUTES: 15,
	PREF_AUTOLOCK_MINUTES: "pref.autoLockMinutes",
}));

import { armFilePickGrace, startAutoLock } from "./auto-lock";

// Let the fire-and-forget maybeLock() chain (two awaited promises) settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

const cleanups: Array<() => void> = [];

beforeEach(() => {
	isLocked.mockResolvedValue(false);
	getMeta.mockResolvedValue(-1); // "Immediately"
	lockForLifecycle.mockResolvedValue(undefined);
});

afterEach(() => {
	for (const c of cleanups.splice(0)) c();
	vi.clearAllMocks();
});

describe("auto-lock lifecycle under 'Immediately'", () => {
	it("locks the moment the app leaves the foreground (the pre-fix behavior)", async () => {
		cleanups.push(startAutoLock());
		handlers.appStateChange?.({ isActive: false });
		await vi.waitFor(() => expect(lockForLifecycle).toHaveBeenCalledTimes(1));
	});

	// The reported bug: opening a file picker backgrounds the app, which locked the vault
	// mid-import. Arming the grace must carry the session across that leave→return cycle.
	it("does not lock across a file-pick leave/return, then locks normally afterward", async () => {
		cleanups.push(startAutoLock());

		armFilePickGrace();
		handlers.appStateChange?.({ isActive: false }); // OS picker opens → app backgrounds
		await flush();
		expect(lockForLifecycle).not.toHaveBeenCalled();

		handlers.resume?.(); // user returns with the chosen file
		await flush();
		expect(lockForLifecycle).not.toHaveBeenCalled();

		// Grace is consumed: the next real background locks as usual.
		handlers.appStateChange?.({ isActive: false });
		await vi.waitFor(() => expect(lockForLifecycle).toHaveBeenCalledTimes(1));
	});
});
