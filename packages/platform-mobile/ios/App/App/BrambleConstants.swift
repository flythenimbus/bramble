import Foundation

// Single source of truth for the cross-process autofill + biometric identifiers. The main
// app (AutofillBridge, BiometricVault) WRITES these and the AutoFill extension READS them,
// so they must match byte-for-byte across both targets - this file is compiled into the App
// AND the AutoFillProbe target (see scripts/add-native-crypto.rb). The App Group and the
// Keychain access group also appear in the .entitlements files and must agree with them.
enum BrambleVault {
	// App Group container shared by the app and the AutoFill extension.
	static let appGroup = "group.app.bramble.mobile"
	// Team-prefixed shared Keychain access group (the keychain-access-groups entitlement).
	static let accessGroup = "BHGR3PP64J.app.bramble.mobile.shared"

	// Keychain item: the biometric-gated VEK cache (BiometricVault writes, extension reads).
	static let biometricService = "app.bramble.mobile.biometric-vault"
	static let vekAccount = "vek"
	// Keychain item: the keep-unlocked session VEK (device-unlock gated, time-limited).
	static let sessionService = "app.bramble.mobile.autofill-session"

	// App Group keys: the VEK-encrypted login bundle, the password slot, the keep-unlocked window.
	static let bundleKey = "autofill.bundle"
	static let slotKey = "autofill.slot"
	static let keepUnlockedKey = "autofill.keepUnlockedMinutes"
}
