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

// Platform capabilities: TS/UI gates resolved per build target via `can()` / `useCan` (from
// Platform.target). Unlike the Rust-mirrored `flags` above, a value may vary by target; each entry
// is a bare bool, { extension, mobile }, or { chromium, firefox, android, ios }. Methods stay on the adapter.

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
	restore: true,
	popOut: { extension: true, mobile: false },
	cameraScan: { extension: false, mobile: true },
	// Not shipped on mobile yet.
	cloudBackup: { extension: true, mobile: false },
	// Firefox's moz-extension origin is rejected as a WebAuthn RP; mobile has no `prf`.
	securityKeys: { chromium: true, firefox: false, android: false, ios: false },
	// Corner-prompt / Android autofill save; no iOS save surface.
	saveCapture: { chromium: true, firefox: true, android: true, ios: false },
	// In-app runtime toggle for the passkey provider (extension only; mobile's provider is OS-managed).
	passkeyProviderToggle: { chromium: true, firefox: true, android: false, ios: false },
	// Separate "lock when the OS screen locks" toggle. Extension only: mobile locks on app
	// backgrounding via the auto-lock setting, with no distinct screen-lock signal. See issue #6.
	lockOnScreenLock: { extension: true, mobile: false },
	// The background sync engine targets the active (not just primary) vault, so each vault
	// syncs independently. Extension only for now; mobile's sync-manager still binds to the
	// primary vault, so a non-primary vault there shows "coming soon". See docs/multiple-vaults.md.
	perVaultSync: { extension: true, mobile: false },
} satisfies Record<string, Capability>;

export type CapabilityKey = keyof typeof CAPABILITIES;

/** Resolve a capability for a build target (`useCan` wraps this with the current platform). */
export function can(cap: CapabilityKey, target: Target): boolean {
	const v = CAPABILITIES[cap];
	if (typeof v === "boolean") return v;
	return "chromium" in v ? v[target] : v[SURFACE[target]];
}
