// Device-local biometric (Face ID / Touch ID / Android BiometricPrompt) convenience
// unlock. This is NOT a vault-format slot: the VEK is cached on THIS device behind an
// OS-enforced gate (Secure Enclave / Keystore; the cached key is dropped when the enrolled
// set changes, unless iOS passcode fallback is on), so the vault file stays portable and
// slot-policy is untouched.
// A device holding this cache skips the Argon2 password/recovery KDF; it never replaces
// those slots, which remain the portable unlock methods. Optional on `Platform` — only
// mobile supplies it; the extension leaves it undefined.
/** Best-effort modality for UI copy/icon. Android can't distinguish the enrolled
 * modality, so it reports "biometric"; iOS maps LAContext.biometryType, and reports
 * "passcode" when nothing is enrolled but the device passcode can still open the gate. */
export type BiometryType = "faceId" | "touchId" | "opticId" | "passcode" | "biometric";

// iOS only: whether the device passcode may open the gate as well as biometry. The gate is
// chosen when the VEK is cached, so `enable` writes it and `unlock` has to prompt with a
// matching policy - a passcode-authenticated context can't open a biometry-only item. Android
// ignores it: its Keystore key is biometry-only already, and allowing DEVICE_CREDENTIAL there
// needs the key authorized for it at generation (API 30+, minSdk is 24).
export interface BiometricUnlock {
	/** Hardware is present and a biometric OR the device passcode is usable, so enable/unlock can be offered. */
	isAvailable(): Promise<boolean>;
	/** Which modality is enrolled, for labelling the unlock UI. Defaults to "biometric". */
	biometryType?(): Promise<BiometryType>;
	/** A biometric is actually enrolled, so a biometry-only gate is possible. False on a
	 * passcode-only device, where passcode fallback is the only gate there is. */
	biometryEnrolled?(): Promise<boolean>;
	// Each vault's VEK is a distinct OS-gated item, keyed by vault id, so enabling biometric on one
	// vault never overwrites another's cached VEK. (`vaultId` = the active vault's local id.)
	/** A VEK is currently cached behind the biometric gate for this vault. */
	isEnabled(vaultId: string): Promise<boolean>;
	/**
	 * Whether `enable` provably raises NO prompt of its own, so the gate may be re-armed behind
	 * the user's back to reconcile a setting.
	 *
	 * Stated this way round on purpose. iOS writes its Keychain item silently; Android's Keystore
	 * key is created `setUserAuthenticationRequired`, so encrypting the VEK needs a
	 * BiometricPrompt. The first cut asked the opposite question ("does enable need auth?"), which
	 * meant every unknown answered "no" and re-armed - and the platform read behind it falls back
	 * to "web" whenever the Capacitor bridge has not been injected yet, so an unknown was reachable.
	 * Absent or false costs at most a skipped reconcile; a wrong `true` costs the user a prompt
	 * they did not ask for, and a cancelled one can strand the gate. Default to the cheap mistake.
	 */
	enableIsSilent?: boolean;
	/** Cache the vault's VEK (base64) behind the biometric gate. Call once with the vault unlocked.
	 * Re-arms in place, so it is also how `allowPasscode` is changed after the fact. */
	enable(vekB64: string, vaultId: string, allowPasscode: boolean): Promise<void>;
	/** Biometric-prompt, then return this vault's cached VEK (base64). Rejects on cancel/lockout/invalidation. */
	unlock(vaultId: string, allowPasscode: boolean): Promise<string>;
	/** Remove this vault's cached VEK from the device. */
	disable(vaultId: string): Promise<void>;
}

/** Both native plugins reject a user-dismissed prompt with this code. A prompt the OS pulled
 * instead (still transitioning to the foreground) gets "interrupted", which is worth retrying. */
const BIOMETRIC_CANCELLED = "cancelled";
/** The OS pulled the prompt (app still coming to the foreground, another sheet in the way). */
const BIOMETRIC_INTERRUPTED = "interrupted";
/** The gate itself is gone: the OS destroyed the cached VEK because the enrolled biometric set
 * changed. Nothing can reopen it, so the cache has to be torn down and re-armed by hand. */
const BIOMETRIC_INVALIDATED = "invalidated";
/** Too many failed matches. With passcode fallback off there is no way out inside the policy:
 * the device has to be unlocked by passcode first, or the master password used instead. */
const BIOMETRIC_LOCKOUT = "lockout";

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

/** The OS pulled the prompt before anyone answered, so the gate never opened. The ONE outcome
 * worth asking again for: iOS refuses to present for a beat after the app returns to the
 * foreground. Anything else either got an answer or is broken, and re-asking just repeats it. */
export function isBiometricInterrupted(error: unknown): boolean {
	return hasCode(error, BIOMETRIC_INTERRUPTED);
}

/** The user dismissed the prompt, as opposed to the gate failing or the OS pulling it. */
export function isBiometricCancel(error: unknown): boolean {
	return hasCode(error, BIOMETRIC_CANCELLED);
}

/** The enrolled biometric set changed, so the OS discarded the cached VEK. */
export function isBiometricInvalidated(error: unknown): boolean {
	return hasCode(error, BIOMETRIC_INVALIDATED);
}

/** Biometry is locked out after repeated failures. */
export function isBiometricLockout(error: unknown): boolean {
	return hasCode(error, BIOMETRIC_LOCKOUT);
}
