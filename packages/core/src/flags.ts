// Build-time feature flags. Single source of truth: `flags.json` in this directory, which is also
// read by core-rust (see packages/core-rust/build.rs), so TS and Rust never drift. Each flag
// defaults to the CONSERVATIVE value; flip it in a later release once the fleet is capable, then
// ship. Never a runtime/remote fetch - these are baked at build time. See
// docs/p2p-sync-revocation-hardening.md for the phase-1 -> phase-2 rollout, and read its flip
// checklist before touching either roster flag: "the fleet is capable" is a thing to verify in
// Settings -> Sync (every live device signed), not a length of time that has passed.

import flagsJson from "./flags.json";

export interface Flags {
	/** Reject an unsigned roster entry for a not-yet-established id (phase-2). Default false =
	 * verify-if-present, so a not-yet-upgraded device is tolerated during rollout. */
	rosterRequireSignatures: boolean;
	/** Reject a brand-new roster id that carries no valid admission (phase-2) - this is what gives
	 * the rogue-injection close its teeth. Default false during rollout. */
	rosterRequireAdmission: boolean;
	/**
	 * Offer "Rotate secret" in Settings. Default false: the operation is correct and tested, but
	 * it is the one action here that ends with other devices unable to read the vault and a
	 * recovery code the user must save in that moment. Worth having behind a flag until it has
	 * been exercised on real vaults, because the failure mode is somebody's whole vault.
	 */
	rotateVaultSecret: boolean;
}

export const flags: Flags = flagsJson;

// Platform capabilities: TS/UI gates resolved per build target via `can()` / `useCan` (from
// Platform.target). Unlike the Rust-mirrored `flags` above, a value may vary by target; each entry
// is a bare bool, { extension, mobile }, or { chromium, firefox, android, ios }. Methods stay on the adapter.

export type Target = "chromium" | "firefox" | "android" | "ios" | "desktop";
/** Input model, and nothing else: hover affordances vs long-press. */
export type Surface = "pointer" | "touch";

const SURFACE: Record<Target, Surface> = {
	chromium: "pointer",
	firefox: "pointer",
	android: "touch",
	ios: "touch",
	desktop: "pointer",
};

/**
 * How a target is built and hosted. Most capabilities vary along this axis rather than the
 * input one, which is why the two are separate: desktop is pointer-driven like the
 * extension but shares almost none of its host APIs (no tabs, no popup, no offscreen).
 */
type Family = "extension" | "mobile" | "desktop";

const FAMILY: Record<Target, Family> = {
	chromium: "extension",
	firefox: "extension",
	android: "mobile",
	ios: "mobile",
	desktop: "desktop",
};

/** The input model a target renders for. */
export function surfaceOf(target: Target): Surface {
	return SURFACE[target];
}

type Capability =
	| boolean
	| Record<Family, boolean>
	| { chromium: boolean; firefox: boolean; android: boolean; ios: boolean; desktop: boolean };

export const CAPABILITIES = {
	// Desktop is already a window, so there is nothing to detach into.
	popOut: { extension: true, mobile: false, desktop: false },
	// Desktop webcams exist, but webview camera access is inconsistent across the three
	// engines; pairing codes are pasted instead. See docs/desktop-port.md.
	cameraScan: { extension: false, mobile: true, desktop: false },
	// Not shipped on mobile yet. Desktop is the natural host and the only one that can keep a
	// schedule: tray-resident, credentials in the OS store, so a vault's timer is honoured while
	// it is locked. Its S3 + WebDAV tiles work; the one-click OAuth tile stays hidden there until
	// the shell adapter grows `connectBackupOAuth`.
	cloudBackup: { extension: true, mobile: false, desktop: true },
	// EXTERNAL security keys (YubiKey). Firefox supports `prf` for platform authenticators only,
	// not for external keys, so this stays off there even though webauthnUnlock is on. Mobile has
	// no `prf`; desktop webviews have no usable WebAuthn at all and wait on a native CTAP path.
	securityKeys: { chromium: true, firefox: false, android: false, ios: false, desktop: false },
	// Unlocking via a webauthn slot at all, by either a platform authenticator (Touch ID /
	// Windows Hello) or an external key. Measured working on both browsers, on macOS and Windows;
	// Firefox needs an explicit rpID to get there, see `webauthnRpId` below and
	// docs/security-keys.md. Superset of securityKeys: it gates the Tap to unlock section, while
	// securityKeys decides whether that section offers to add an external key.
	webauthnUnlock: { chromium: true, firefox: true, android: false, ios: false, desktop: false },
	// Corner-prompt / Android autofill save; no iOS save surface. Desktop has no page of
	// its own to capture from; the extension keeps doing this even once the two are paired.
	saveCapture: { chromium: true, firefox: true, android: true, ios: false, desktop: false },
	// In-app on/off switch for page autofill (the in-page dropdown). Extension only: mobile's
	// autofill is enabled in OS settings and desktop has no page of its own to fill.
	autofillToggle: {
		chromium: true,
		firefox: true,
		android: false,
		ios: false,
		desktop: false,
	},
	// In-app runtime toggle for the passkey provider (extension only; mobile's provider is OS-managed).
	passkeyProviderToggle: {
		chromium: true,
		firefox: true,
		android: false,
		ios: false,
		desktop: false,
	},
	// OS-driven credential exchange (FIDO CXP): app-to-app transfer of logins and passkeys with
	// no file in between. iOS 26+ only. Android's routing lives in Google Play services, which
	// we don't ship; the extension has no such API. See docs/credential-exchange.md.
	credentialExchange: {
		chromium: false,
		firefox: false,
		android: false,
		ios: true,
		desktop: false,
	},
	// Filter the file picker by extension. Extension only: the native document pickers on
	// Android and iOS match on MIME type and grey out extensions they can't map, which is every
	// container format we read (.1pux, .kdbx, .bramble). Mobile omits `accept` so the file is
	// selectable at all. See github issue #36.
	// Desktop's native dialogs filter by extension properly, unlike the mobile pickers.
	filePickerAcceptFilter: { extension: true, mobile: false, desktop: true },
	// Separate "let the device passcode open the biometric gate" toggle. iOS only: the gate is
	// a Keychain access control picked at write time, so both options exist there (.userPresence
	// vs .biometryCurrentSet). Android's Keystore key is biometry-only already - allowing
	// DEVICE_CREDENTIAL needs the key authorized for it at generation (API 30+, minSdk is 24) -
	// and no other target has a biometric gate at all. See docs/auth-and-unlock.md.
	biometricPasscodeFallback: {
		chromium: false,
		firefox: false,
		android: false,
		ios: true,
		desktop: false,
	},
	// Separate "lock when the OS screen locks" toggle. Extension only: mobile locks on app
	// backgrounding via the auto-lock setting, with no distinct screen-lock signal. See issue #6.
	// Desktop OSes emit a real screen-lock signal, but nothing subscribes to it yet.
	lockOnScreenLock: { extension: true, mobile: false, desktop: false },
	// SIMULTANEOUS multi-vault sync: several vaults each syncing on their own connection at once.
	// Extension only. Mobile is single-active - its sync-manager targets the active vault's namespaced
	// keys, and only the vault you're in syncs. This flag no longer gates any UI (join + per-vault
	// biometric/autofill have landed on mobile); it just describes that capability difference. The
	// remaining mobile Tier 2 is searching all vaults in autofill at once. See docs/multiple-vaults.md.
	// Desktop is single-active like mobile: the spotlight bar and the app both search the
	// one unlocked vault, which is a settled product decision, not a gap.
	perVaultSync: { extension: true, mobile: false, desktop: false },
} satisfies Record<string, Capability>;

export type CapabilityKey = keyof typeof CAPABILITIES;

/** Resolve a capability for a build target (`useCan` wraps this with the current platform). */
export function can(cap: CapabilityKey, target: Target): boolean {
	const v = CAPABILITIES[cap];
	if (typeof v === "boolean") return v;
	return "chromium" in v ? v[target] : v[FAMILY[target]];
}
