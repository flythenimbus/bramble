import { beforeEach, describe, expect, it, vi } from "vitest";

// The launch-time update nudge. The download and the signature check belong to Tauri; what is
// under test is the decision around them, because that is where a prompt turns into a nuisance:
// asking when there is nothing to install, asking again about a version already declined, or
// downloading something the user did not agree to.

const h = vi.hoisted(() => ({
	available: null as { version: string } | null,
	checkFails: false,
	/** What ask() returns, i.e. what the user clicked. */
	accept: true,
	asked: [] as { body: string; title?: string }[],
	installs: 0,
	navigations: [] as string[],
	meta: new Map<string, unknown>(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	ask: async (body: string, opts?: { title?: string }) => {
		h.asked.push({ body, title: opts?.title });
		return h.accept;
	},
}));

vi.mock("@tauri-apps/api/event", () => ({
	emit: async (_name: string, payload: { href: string }) => {
		h.navigations.push(payload.href);
	},
}));

vi.mock("./adapters/updates", () => ({
	desktopUpdates: {
		check: async () => {
			if (h.checkFails) throw new Error("offline");
			return h.available;
		},
		install: async () => {
			h.installs++;
		},
	},
}));

vi.mock("./adapters/storage", () => ({
	desktopStorage: {
		getMeta: async (k: string) => h.meta.get(k),
		setMeta: async (k: string, v: unknown) => {
			h.meta.set(k, v);
		},
	},
}));

import { promptForUpdateOnLaunch } from "./updates-prompt";

/** Runs the scheduled offer and lets its promise chain settle. */
async function launch(): Promise<void> {
	promptForUpdateOnLaunch();
	await vi.runAllTimersAsync();
}

beforeEach(() => {
	vi.useFakeTimers();
	h.available = { version: "1.2.0" };
	h.checkFails = false;
	h.accept = true;
	h.asked = [];
	h.installs = 0;
	h.navigations = [];
	h.meta = new Map();
});

describe("promptForUpdateOnLaunch", () => {
	it("says nothing when there is no update", async () => {
		h.available = null;
		await launch();

		expect(h.asked).toHaveLength(0);
		expect(h.installs).toBe(0);
	});

	it("asks before installing, and names the version", async () => {
		// Accepting restarts the app, so it is a question rather than something done quietly. The
		// version is in the sentence because "an update is available" is not enough to decide on.
		await launch();

		expect(h.asked).toHaveLength(1);
		expect(h.asked[0]?.body).toContain("1.2.0");
		expect(h.installs).toBe(1);
	});

	it("opens Settings before it starts, so the download is visible", async () => {
		// A system dialog cannot show progress. Without this the app looks idle while it downloads
		// itself and then restarts without warning.
		await launch();

		expect(h.navigations).toEqual(["/settings?tab=about"]);
	});

	it("does not install when the user says Later", async () => {
		h.accept = false;
		await launch();

		expect(h.installs).toBe(0);
	});

	it("drops a declined version rather than asking every launch", async () => {
		// Re-asking about something already refused is how a prompt teaches people to dismiss it
		// without reading, which costs the one that actually matters later.
		h.accept = false;
		await launch();
		expect(h.asked).toHaveLength(1);

		await launch();
		expect(h.asked).toHaveLength(1);
	});

	it("asks again once a newer version appears", async () => {
		h.accept = false;
		await launch();

		h.available = { version: "1.3.0" };
		h.accept = true;
		await launch();

		expect(h.asked).toHaveLength(2);
		expect(h.installs).toBe(1);
	});

	it("stays quiet when the check fails", async () => {
		// Offline on launch is ordinary. Settings still has a Check button that reports the reason.
		h.checkFails = true;
		await expect(launch()).resolves.toBeUndefined();

		expect(h.asked).toHaveLength(0);
	});

	it("does not ask if the window closed first", async () => {
		const cancel = promptForUpdateOnLaunch();
		cancel();
		await vi.runAllTimersAsync();

		expect(h.asked).toHaveLength(0);
	});
});
