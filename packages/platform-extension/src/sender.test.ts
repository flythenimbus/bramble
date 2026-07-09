import { afterEach, describe, expect, it, vi } from "vitest";

// isExtensionSender computes EXTENSION_ORIGIN from chrome.runtime.getURL at module
// load, so stub chrome and (re)import per test. Node's URL gives chrome-extension://
// an opaque origin, so use an https stand-in (string equality is scheme-agnostic).
const EXT_ORIGIN = "https://extension.example";
const runtime = { id: "testext", getURL: (p: string) => `${EXT_ORIGIN}/${p}` };

async function loadSender() {
	vi.resetModules();
	vi.stubGlobal("chrome", { runtime });
	return (await import("./sender")).isExtensionSender;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe("isExtensionSender", () => {
	it("accepts a sender on the extension origin (popup/options/offscreen)", async () => {
		const isExtensionSender = await loadSender();
		expect(isExtensionSender({ origin: EXT_ORIGIN } as any)).toBe(true);
		expect(isExtensionSender({ url: `${EXT_ORIGIN}/offscreen.html` } as any)).toBe(true);
	});

	it("rejects a content script (page origin + tab)", async () => {
		const isExtensionSender = await loadSender();
		expect(
			isExtensionSender({
				origin: "https://evil.com",
				url: "https://evil.com/login",
				tab: { id: 1 },
			} as any),
		).toBe(false);
	});

	it("rejects a page-origin sender even without a tab", async () => {
		const isExtensionSender = await loadSender();
		expect(isExtensionSender({ origin: "https://evil.com" } as any)).toBe(false);
	});

	it("rejects any sender carrying a tab, even one claiming the extension origin", async () => {
		const isExtensionSender = await loadSender();
		expect(isExtensionSender({ origin: EXT_ORIGIN, tab: { id: 1 } } as any)).toBe(false);
	});

	it("falls back to the same-extension id when origin and url are absent", async () => {
		const isExtensionSender = await loadSender();
		expect(isExtensionSender({ id: "testext" } as any)).toBe(true); // legit SW/offscreen, no origin
		expect(isExtensionSender({ id: "otherext" } as any)).toBe(false);
		expect(isExtensionSender({} as any)).toBe(false);
	});
});
