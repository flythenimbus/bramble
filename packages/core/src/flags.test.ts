import { describe, expect, it } from "vitest";
import { CAPABILITIES, can, type Target } from "./flags";

const TARGETS: Target[] = ["chromium", "firefox", "android", "ios"];

describe("can()", () => {
	it("resolves an { extension, mobile } capability by surface", () => {
		// `cloudBackup` is extension-only.
		expect(can("cloudBackup", "chromium")).toBe(true);
		expect(can("cloudBackup", "firefox")).toBe(true);
		expect(can("cloudBackup", "android")).toBe(false);
		expect(can("cloudBackup", "ios")).toBe(false);
	});

	it("resolves a per-target capability that varies within a surface", () => {
		// `securityKeys`: chromium yes, firefox no (moz-extension origin rejected); mobile no.
		expect(can("securityKeys", "chromium")).toBe(true);
		expect(can("securityKeys", "firefox")).toBe(false);
		// `saveCapture`: android yes, iOS no (no save surface).
		expect(can("saveCapture", "android")).toBe(true);
		expect(can("saveCapture", "ios")).toBe(false);
		// `passkeyProviderToggle`: extension has an in-app toggle; mobile's provider is OS-managed.
		expect(can("passkeyProviderToggle", "chromium")).toBe(true);
		expect(can("passkeyProviderToggle", "firefox")).toBe(true);
		expect(can("passkeyProviderToggle", "android")).toBe(false);
		expect(can("passkeyProviderToggle", "ios")).toBe(false);
		// `credentialExchange`: iOS alone. Android's routing is in Play services, which we don't
		// ship, and the extension has no equivalent API.
		expect(can("credentialExchange", "ios")).toBe(true);
		expect(can("credentialExchange", "android")).toBe(false);
		expect(can("credentialExchange", "chromium")).toBe(false);
		expect(can("credentialExchange", "firefox")).toBe(false);
	});

	it("returns a boolean for every capability on every target", () => {
		for (const cap of Object.keys(CAPABILITIES) as (keyof typeof CAPABILITIES)[])
			for (const t of TARGETS) expect(typeof can(cap, t)).toBe("boolean");
	});
});
