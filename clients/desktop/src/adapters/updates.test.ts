import { beforeEach, describe, expect, it, vi } from "vitest";

// The launch-check setting. The privacy policy says the desktop app checks for updates when it
// opens and that this can be turned off, so the default and the off switch are both promises.

const h = vi.hoisted(() => ({ meta: new Map<string, unknown>() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => true }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: async () => {} }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: async () => null }));
vi.mock("./storage", () => ({
	desktopStorage: {
		getMeta: async (k: string) => h.meta.get(k),
		setMeta: async (k: string, v: unknown) => {
			h.meta.set(k, v);
		},
	},
}));

const { desktopUpdates } = await import("./updates");

beforeEach(() => {
	h.meta = new Map();
});

describe("checkOnLaunch", () => {
	it("is on for a fresh install", async () => {
		// Nothing stored yet is the state most people stay in, and a fix that reaches nobody
		// fixes nothing.
		expect(await desktopUpdates.checkOnLaunch?.()).toBe(true);
	});

	it("stays off once turned off", async () => {
		await desktopUpdates.setCheckOnLaunch?.(false);

		expect(await desktopUpdates.checkOnLaunch?.()).toBe(false);
	});

	it("turns back on", async () => {
		await desktopUpdates.setCheckOnLaunch?.(false);
		await desktopUpdates.setCheckOnLaunch?.(true);

		expect(await desktopUpdates.checkOnLaunch?.()).toBe(true);
	});
});
