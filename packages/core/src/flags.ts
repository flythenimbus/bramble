// Build-time feature flags. Single source of truth: `flags.json` in this directory, which is also
// read by core-rust (see packages/core-rust/build.rs), so TS and Rust never drift. Each flag
// defaults to the CONSERVATIVE value; flip it in a later release once the fleet is capable, then
// ship. Never a runtime/remote fetch - these are baked at build time. See
// docs/p2p-sync-revocation-hardening.md for the phase-1 -> phase-2 rollout.

import flagsJson from "./flags.json";

export interface Flags {
	/** Reject an unsigned roster entry for a not-yet-established id (phase-2). Default false =
	 * verify-if-present, so a not-yet-upgraded device is tolerated during rollout. */
	rosterRequireSignatures: boolean;
	/** Reject a brand-new roster id that carries no valid admission (phase-2) - this is what gives
	 * the rogue-injection close its teeth. Default false during rollout. */
	rosterRequireAdmission: boolean;
}

export const flags: Flags = flagsJson;

// --- Platform capabilities -----------------------------------------------------------------------
// Colocated with `flags` above so all gating is reasoned about in one place. Difference: `flags` are
// GLOBAL build-time booleans mirrored to core-rust via flags.json; capabilities are TS/UI-only and
// their value can VARY BY BUILD TARGET. A capability is resolved at runtime from the platform's
// `target` identity (see Platform.target) via `can()` / the `useCan` hook. Each entry is one of:
// a bare boolean (same everywhere), { extension, mobile } (by surface), or the full
// { chromium, firefox, android, ios } (by target). Behaviour/methods stay on the ShellAdapter.

export type Target = "chromium" | "firefox" | "android" | "ios";
export type Surface = "extension" | "mobile";

const SURFACE: Record<Target, Surface> = {
	chromium: "extension",
	firefox: "extension",
	android: "mobile",
	ios: "mobile",
};

type Capability =
	| boolean
	| { extension: boolean; mobile: boolean }
	| { chromium: boolean; firefox: boolean; android: boolean; ios: boolean };

export const CAPABILITIES = {
	/** Restore/import a .bramble backup from a file picker. */
	restore: true,
	/** Detach the UI into a standalone window (single-window hosts like mobile cannot). */
	popOut: { extension: true, mobile: false },
	/** `scanQrFromActiveTab` is a live device-camera scan (mobile) vs an active-tab capture (extension). */
	cameraScan: { extension: false, mobile: true },
	/** Cloud storage backup providers (S3 / WebDAV / OAuth). Not shipped on mobile yet. */
	cloudBackup: { extension: true, mobile: false },
	/** WebAuthn security-key unlock. Firefox's moz-extension origin is rejected as an RP; mobile has no `prf`. */
	securityKeys: { chromium: true, firefox: false, android: false, ios: false },
	/** Capture a submitted login and offer to save it (corner-prompt / Android autofill save; no iOS surface). */
	saveCapture: { chromium: true, firefox: true, android: true, ios: false },
	/** Act as a WebAuthn passkey provider for other sites: Chromium via chrome.webAuthenticationProxy,
	 *  Firefox via a MAIN-world content-script override (docs/firefox-port.md). Mobile uses OS credential providers. */
	passkeyProvider: { chromium: true, firefox: true, android: false, ios: false },
} satisfies Record<string, Capability>;

export type CapabilityKey = keyof typeof CAPABILITIES;

/** Resolve a capability for a build target. Pure; the `useCan` hook wraps it with the current platform. */
export function can(cap: CapabilityKey, target: Target): boolean {
	const v = CAPABILITIES[cap];
	if (typeof v === "boolean") return v;
	return "chromium" in v ? v[target] : v[SURFACE[target]];
}
