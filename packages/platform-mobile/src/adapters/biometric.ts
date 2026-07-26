import { registerPlugin } from "@capacitor/core";
import type { BiometricUnlock, BiometryType } from "@core/index";

// The native local plugin (ios/App/App/BiometricVault.swift, android .../BiometricVaultPlugin.java)
// that holds the VEK behind an OS-enforced gate: iOS Keychain item with a .userPresence
// access control + Secure Enclave (biometry OR device passcode); Android a Keystore AES key
// created setUserAuthenticationRequired + setInvalidatedByBiometricEnrollment (biometry only).
// The OS itself prompts on getSecret; we never run the Argon2 KDF here.
// Each vault's VEK is a distinct native item, keyed by `vaultId` (the item's Keychain account /
// Keystore alias includes it), so enabling biometric on one vault can't overwrite another's.
interface BiometricVaultPlugin {
	isAvailable(): Promise<{ available: boolean; biometryType?: string }>;
	hasSecret(options: { vaultId: string }): Promise<{ value: boolean }>;
	setSecret(options: { vaultId: string; secret: string }): Promise<void>;
	getSecret(options: { vaultId: string; reason: string }): Promise<{ secret: string }>;
	deleteSecret(options: { vaultId: string }): Promise<void>;
}

const Native = registerPlugin<BiometricVaultPlugin>("BiometricVault");

// Maps the native plugin to the core BiometricUnlock capability. The availability and
// enabled probes swallow errors (e.g. the browser dev build, where the native plugin
// is absent) so the UI simply hides the feature instead of throwing.
export const mobileBiometric: BiometricUnlock = {
	async isAvailable() {
		try {
			return (await Native.isAvailable()).available;
		} catch {
			return false;
		}
	},
	async biometryType(): Promise<BiometryType> {
		try {
			const t = (await Native.isAvailable()).biometryType;
			return t === "faceId" || t === "touchId" || t === "opticId" || t === "passcode"
				? t
				: "biometric";
		} catch {
			return "biometric";
		}
	},
	async isEnabled(vaultId) {
		try {
			return (await Native.hasSecret({ vaultId })).value;
		} catch {
			return false;
		}
	},
	async enable(vekB64, vaultId) {
		await Native.setSecret({ vaultId, secret: vekB64 });
	},
	async unlock(vaultId) {
		return (await Native.getSecret({ vaultId, reason: "Unlock your vault" })).secret;
	},
	async disable(vaultId) {
		await Native.deleteSecret({ vaultId });
	},
};
