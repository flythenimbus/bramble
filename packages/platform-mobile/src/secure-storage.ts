import { type DataType, SecureStorage } from "@aparajita/capacitor-secure-storage";

// Keychain (iOS) / Keystore-backed encrypted store (Android) for high-value secrets
// that must NOT sit in @capacitor/preferences (plaintext UserDefaults/SharedPreferences):
// the sync device private key today, and the biometric-gated VEK-wrapping key next.
// The plugin serializes objects, so values round-trip as-is.
export const secureStorage = {
	get<T>(key: string): Promise<T | null> {
		return SecureStorage.get(key) as Promise<T | null>;
	},
	set(key: string, value: unknown): Promise<void> {
		return SecureStorage.set(key, value as DataType);
	},
	remove(key: string): Promise<void> {
		return SecureStorage.removeItem(key);
	},
};
