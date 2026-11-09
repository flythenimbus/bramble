import { describe, expect, it } from "vitest";
import { DEFAULT_RELAY, isRelayUrl, relayOrDefault } from "./relay-url";

describe("relayOrDefault", () => {
	it("uses the hosted relay when nothing is saved", () => {
		expect(relayOrDefault(undefined)).toBe(DEFAULT_RELAY);
		expect(relayOrDefault(null)).toBe(DEFAULT_RELAY);
	});

	it("treats a cleared field as nothing saved", () => {
		expect(relayOrDefault("")).toBe(DEFAULT_RELAY);
		expect(relayOrDefault("   ")).toBe(DEFAULT_RELAY);
	});

	it("keeps a saved relay, without the spaces around it", () => {
		expect(relayOrDefault(" wss://relay.example.com/?token=abc ")).toBe(
			"wss://relay.example.com/?token=abc",
		);
	});

	// Falling back here would quietly move someone off the relay they chose because of a typo.
	it("leaves an address that can't work for the mesh to refuse, rather than the hosted relay", () => {
		expect(relayOrDefault("relay.example.com")).toBe("relay.example.com");
	});
});

describe("isRelayUrl", () => {
	it("accepts what a WebSocket can open", () => {
		for (const url of [
			DEFAULT_RELAY,
			"ws://localhost:7400",
			"wss://relay.example.com/?token=abc",
			"https://relay.example.com",
		]) {
			expect(isRelayUrl(url), url).toBe(true);
		}
	});

	// Each of these gave "The string did not match the expected pattern." in the desktop and iOS
	// webviews, whose tauri:// and capacitor:// origins a relative address resolves against.
	it("refuses the rest", () => {
		for (const url of [
			"",
			"   ",
			"relay.example.com",
			"ftp://relay.example.com",
			"wss://relay example.com",
			"wss://",
		]) {
			expect(isRelayUrl(url), JSON.stringify(url)).toBe(false);
		}
	});
});
