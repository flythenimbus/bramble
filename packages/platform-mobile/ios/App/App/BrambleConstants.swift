import Foundation
import Security

// Single source of truth for the cross-process autofill + biometric identifiers. The main
// app (AutofillBridge, BiometricVault) WRITES these and the AutoFill extension READS them,
// so they must match byte-for-byte across both targets - this file is compiled into the App
// AND the AutoFillProbe target (see scripts/add-native-crypto.rb). The App Group and the
// Keychain access group also appear in the .entitlements files and must agree with them.
enum BrambleVault {
	// App Group container shared by the app and the AutoFill extension.
	static let appGroup = "group.app.bramble.mobile"
	// Shared Keychain access group, shared by the app and the AutoFill extension. This MUST equal
	// the resolved keychain-access-groups entitlement ($(AppIdentifierPrefix)app.bramble.mobile.shared)
	// so both targets address the same item. Hardcoded to the signing team's App ID Prefix:
	// resolving it at runtime via a Keychain probe proved unreliable (the probe's own group-less
	// read fails to find its item on device, so it returned an un-prefixed group and setSecret hit
	// errSecMissingEntitlement / -34018). Verified against `codesign -d --entitlements` on the
	// archive. If the signing team ever changes, update this to match the new $(AppIdentifierPrefix).
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
	// The VEK-encrypted passkey bundle (provider role); a second blob alongside the logins so
	// the password-fill path is untouched. The extension decrypts it to assert a passkey.
	static let passkeyBundleKey = "autofill.passkeys"
	// Handoff for passkeys the extension MINTS during a registration: the extension can't write
	// the vault, so it stashes each new credential (VEK-encrypted) here and the main app drains
	// it on next launch. Array of {iv, ciphertext}. Mirrors Android's PendingSave.
	static let pendingPasskeysKey = "autofill.pendingPasskeys"

}
