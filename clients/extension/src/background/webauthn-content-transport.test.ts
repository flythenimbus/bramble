import { describe, expect, it, vi } from "vitest";

// A proxy namespace means Chrome, so importing registers no Firefox listeners.
vi.mock("../platform-api", () => ({ api: { webAuthenticationProxy: {} } }));
vi.mock("./router", () => ({ on: vi.fn() }));
vi.mock("./webauthn-provider", () => ({ depsForTab: vi.fn(), isProviderEnabled: () => true }));
vi.mock("./webauthn-proxy", () => ({ handleCreate: vi.fn(), handleGet: vi.fn() }));

import { senderCaller } from "./webauthn-content-transport";

describe("senderCaller (which Firefox frames the provider serves)", () => {
	const tab = { id: 4, url: "https://shop.example/checkout" } as chrome.tabs.Tab;

	it("serves the top frame as itself", () => {
		expect(senderCaller({ frameId: 0, origin: "https://shop.example", tab })).toEqual({
			caller: { origin: "https://shop.example", crossOrigin: false },
			tabId: 4,
		});
	});

	it("serves a child frame that is same-origin with the top", () => {
		expect(senderCaller({ frameId: 2, origin: "https://shop.example", tab })?.tabId).toBe(4);
	});

	// A frame can post to the bridge directly, so this is the only gate it can't skip.
	it("passes a cross-origin child frame through to the native authenticator", () => {
		expect(senderCaller({ frameId: 3, origin: "https://ads.example", tab })).toBeNull();
	});

	it("passes through a sender without a tab or a web origin", () => {
		expect(senderCaller({ frameId: 0, origin: "https://shop.example" })).toBeNull();
		expect(senderCaller({ frameId: 0, origin: "moz-extension://abc", tab })).toBeNull();
	});
});
