import { describe, expect, it } from "vitest";
import { CAPABILITIES, can, type Target } from "./flags";

const TARGETS: Target[] = ["chromium", "firefox", "android", "ios"];

describe("can()", () => {
	it("resolves an { extension, mobile } capability by surface", () => {
		// `cloudBackup`: the extension and the desktop, not mobile. Desktop is the one that can
		// keep a schedule (tray-resident, credentials in the OS store, so a locked vault still
		// backs up); mobile has no background scheduler at all.
		expect(can("cloudBackup", "chromium")).toBe(true);
		expect(can("cloudBackup", "firefox")).toBe(true);
		expect(can("cloudBackup", "desktop")).toBe(true);
		expect(can("cloudBackup", "android")).toBe(false);
		expect(can("cloudBackup", "ios")).toBe(false);
	});

	it("keeps webauthnUnlock a superset of securityKeys, which is the whole point of two flags", () => {
		// Firefox does `prf` for platform authenticators (Touch ID / Windows Hello) but not for
		// external keys, so it can unlock via a webauthn slot while still refusing a YubiKey.
		// Everywhere else the two agree. See docs/security-keys.md.
		expect(can("webauthnUnlock", "firefox")).toBe(true);
		expect(can("securityKeys", "firefox")).toBe(false);
		for (const target of TARGETS) {
			if (can("securityKeys", target)) expect(can("webauthnUnlock", target)).toBe(true);
		}
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
		// `filePickerAcceptFilter`: extension only. Native document pickers grey out extensions
		// they can't map to a MIME type, which is every container format we read (issue #36).
		expect(can("filePickerAcceptFilter", "chromium")).toBe(true);
		expect(can("filePickerAcceptFilter", "firefox")).toBe(true);
		expect(can("filePickerAcceptFilter", "android")).toBe(false);
		expect(can("filePickerAcceptFilter", "ios")).toBe(false);
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
