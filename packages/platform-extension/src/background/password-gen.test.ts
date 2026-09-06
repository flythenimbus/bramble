import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.unstubAllGlobals();
});

// The generator reads chrome.storage.local (through prefs) and registers a router handler on
// import; stub both and load it fresh so each case sees its own settings.
async function load(local: Record<string, unknown> = {}) {
	vi.resetModules();
	vi.stubGlobal("chrome", {
		storage: {
			local: {
				get: async (query: unknown) => {
					const keys = typeof query === "string" ? [query] : (query as string[]);
					const out: Record<string, unknown> = {};
					for (const k of keys) if (k in local) out[k] = local[k];
					return out;
				},
			},
		},
		// The router's module side-effects run on import: it registers a listener and computes the
		// extension origin from getURL.
		runtime: {
			onMessage: { addListener: () => {} },
			getURL: (path: string) => `chrome-extension://bramble/${path}`,
		},
	});
	return import("./password-gen");
}

describe("generateSuggestion", () => {
	it("follows the settings the app saved", async () => {
		const { generateSuggestion } = await load({
			"pref.generator": { mode: "password", length: 32, symbols: false, uppercase: false },
		});
		const password = await generateSuggestion();
		expect(password).toHaveLength(32);
		expect(password).toMatch(/^[a-z0-9]+$/);
	});

	it("builds a passphrase from the real wordlist", async () => {
		const { generateSuggestion } = await load({
			"pref.generator": { mode: "passphrase", words: 4, separator: "." },
		});
		const words = (await generateSuggestion()).split(".");
		expect(words).toHaveLength(4);
		for (const word of words) expect(word).toMatch(/^[a-z-]{3,}$/);
	});

	it("falls back to the defaults when nothing is stored", async () => {
		const { generateSuggestion } = await load();
		expect(await generateSuggestion()).toHaveLength(20);
	});

	// A stored object from another build is not trusted to still fit the settings type: an
	// unknown mode falls back, and a length out of range is clamped to the floor rather than
	// generating nothing.
	it("normalizes junk rather than generating from it", async () => {
		const { generateSuggestion } = await load({
			"pref.generator": { mode: "nonsense", length: -5 },
		});
		expect(await generateSuggestion()).toHaveLength(8);
	});
});
