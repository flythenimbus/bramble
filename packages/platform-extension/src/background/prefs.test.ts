import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.unstubAllGlobals();
});

// prefs.ts only touches chrome.storage.local; stub a minimal in-memory area and
// import it fresh so each test sees clean state.
async function loadPrefs(local: Record<string, unknown> = {}) {
	vi.resetModules();
	const store = { ...local };
	vi.stubGlobal("chrome", {
		storage: {
			local: {
				get: async (query: unknown) => {
					const keys = typeof query === "string" ? [query] : (query as string[]);
					const out: Record<string, unknown> = {};
					for (const k of keys) if (k in store) out[k] = store[k];
					return out;
				},
				set: async (obj: Record<string, unknown>) => {
					Object.assign(store, obj);
				},
			},
		},
	});
	const prefs = await import("./prefs");
	return { prefs, store };
}

describe("getAutoLockMinutes", () => {
	it("defaults to 15", async () => {
		const { prefs } = await loadPrefs();
		expect(await prefs.getAutoLockMinutes()).toBe(15);
	});
	it("returns a stored finite value: 0 = never, -1 = Immediate, N = minutes", async () => {
		expect(await (await loadPrefs({ "pref.autoLockMinutes": 0 })).prefs.getAutoLockMinutes()).toBe(
			0,
		);
		expect(await (await loadPrefs({ "pref.autoLockMinutes": -1 })).prefs.getAutoLockMinutes()).toBe(
			-1,
		);
		expect(await (await loadPrefs({ "pref.autoLockMinutes": 30 })).prefs.getAutoLockMinutes()).toBe(
			30,
		);
	});
	it("falls back to the default for a non-number value", async () => {
		expect(
			await (await loadPrefs({ "pref.autoLockMinutes": "5" })).prefs.getAutoLockMinutes(),
		).toBe(15);
	});
});

describe("getClipboardSeconds", () => {
	it("defaults to 30", async () => {
		const { prefs } = await loadPrefs();
		expect(await prefs.getClipboardSeconds()).toBe(30);
	});
	it("rejects 0 / negative (must be > 0)", async () => {
		expect(
			await (await loadPrefs({ "pref.clipboardClearSeconds": 0 })).prefs.getClipboardSeconds(),
		).toBe(30);
		expect(
			await (await loadPrefs({ "pref.clipboardClearSeconds": 45 })).prefs.getClipboardSeconds(),
		).toBe(45);
	});
});

describe("getOfferToSavePref", () => {
	it("defaults to true and only honors a boolean", async () => {
		expect(await (await loadPrefs()).prefs.getOfferToSavePref()).toBe(true);
		expect(await (await loadPrefs({ "pref.offerToSave": false })).prefs.getOfferToSavePref()).toBe(
			false,
		);
		expect(await (await loadPrefs({ "pref.offerToSave": "no" })).prefs.getOfferToSavePref()).toBe(
			true,
		);
	});
});

describe("never-save sites", () => {
	it("parses the stored array and filters out non-strings", async () => {
		const { prefs } = await loadPrefs({ "pref.neverSaveSites": ["a.com", 5, "b.com", null] });
		const set = await prefs.getNeverSaveSites();
		expect([...set].sort()).toEqual(["a.com", "b.com"]);
	});
	it("appendNeverSaveSite adds once and persists", async () => {
		const { prefs, store } = await loadPrefs();
		await prefs.appendNeverSaveSite("x.com");
		await prefs.appendNeverSaveSite("x.com"); // dedup
		await prefs.appendNeverSaveSite("y.com");
		expect((store["pref.neverSaveSites"] as string[]).sort()).toEqual(["x.com", "y.com"]);
	});
});
