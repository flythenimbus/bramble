// Device-local biometric (Face ID / Touch ID / Android BiometricPrompt) convenience
// unlock. This is NOT a vault-format slot: the VEK is cached on THIS device behind an
// OS-enforced biometric gate (Secure Enclave / Keystore, auto-invalidated when the
// device's biometric set changes), so the vault file stays portable and slot-policy is
// untouched. A device holding this cache skips the Argon2 password/recovery KDF; it
// never replaces those slots, which remain the portable unlock methods. Optional on
// `Platform` — only mobile supplies it; the extension leaves it undefined.
/** Best-effort biometric modality for UI copy/icon. Android can't distinguish the
 * enrolled modality, so it reports "biometric"; iOS maps LAContext.biometryType. */
export type BiometryType = "faceId" | "touchId" | "opticId" | "biometric";

export interface BiometricUnlock {
	/** Hardware is present and a biometric is enrolled, so enable/unlock can be offered. */
	isAvailable(): Promise<boolean>;
	/** Which modality is enrolled, for labelling the unlock UI. Defaults to "biometric". */
	biometryType?(): Promise<BiometryType>;
	/** A VEK is currently cached behind the biometric gate on this device. */
	isEnabled(): Promise<boolean>;
	/** Cache the VEK (base64) behind the biometric gate. Call once with the vault unlocked. */
	enable(vekB64: string): Promise<void>;
	/** Biometric-prompt, then return the cached VEK (base64). Rejects on cancel/lockout/invalidation. */
	unlock(): Promise<string>;
	/** Remove the cached VEK from this device. */
	disable(): Promise<void>;
}
