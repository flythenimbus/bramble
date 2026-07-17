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
	// Each vault's VEK is a distinct OS-gated item, keyed by vault id, so enabling biometric on one
	// vault never overwrites another's cached VEK. (`vaultId` = the active vault's local id.)
	/** A VEK is currently cached behind the biometric gate for this vault. */
	isEnabled(vaultId: string): Promise<boolean>;
	/** Cache the vault's VEK (base64) behind the biometric gate. Call once with the vault unlocked. */
	enable(vekB64: string, vaultId: string): Promise<void>;
	/** Biometric-prompt, then return this vault's cached VEK (base64). Rejects on cancel/lockout/invalidation. */
	unlock(vaultId: string): Promise<string>;
	/** Remove this vault's cached VEK from the device. */
	disable(vaultId: string): Promise<void>;
}
