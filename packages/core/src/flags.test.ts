import { describe, expect, it } from "vitest";
import { CAPABILITIES, can, type Target } from "./flags";

const TARGETS: Target[] = ["chromium", "firefox", "android", "ios"];

describe("can()", () => {
	it("resolves a bare-boolean capability the same on every target", () => {
		// `restore` is `true` everywhere.
		for (const t of TARGETS) expect(can("restore", t)).toBe(true);
	});

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
	});

	it("returns a boolean for every capability on every target", () => {
		for (const cap of Object.keys(CAPABILITIES) as (keyof typeof CAPABILITIES)[])
			for (const t of TARGETS) expect(typeof can(cap, t)).toBe("boolean");
	});
});
