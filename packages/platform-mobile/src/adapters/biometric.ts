import { registerPlugin } from "@capacitor/core";
import type { BiometricUnlock, BiometryType } from "@core/index";

// The native local plugin (ios/App/App/BiometricVault.swift, android .../BiometricVaultPlugin.java)
// that holds the VEK behind an OS-enforced biometric gate: iOS Keychain item with a
// .biometryCurrentSet access control + Secure Enclave; Android a Keystore AES key created
// setUserAuthenticationRequired + setInvalidatedByBiometricEnrollment. The OS itself
// triggers Face ID / fingerprint on getSecret; we never run the Argon2 KDF here.
interface BiometricVaultPlugin {
	isAvailable(): Promise<{ available: boolean; biometryType?: string }>;
	hasSecret(): Promise<{ value: boolean }>;
	setSecret(options: { secret: string }): Promise<void>;
	getSecret(options: { reason: string }): Promise<{ secret: string }>;
	deleteSecret(): Promise<void>;
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
			return t === "faceId" || t === "touchId" || t === "opticId" ? t : "biometric";
		} catch {
			return "biometric";
		}
	},
	async isEnabled() {
		try {
			return (await Native.hasSecret()).value;
		} catch {
			return false;
		}
	},
	async enable(vekB64) {
		await Native.setSecret({ secret: vekB64 });
	},
	async unlock() {
		return (await Native.getSecret({ reason: "Unlock your vault" })).secret;
	},
	async disable() {
		await Native.deleteSecret();
	},
};
