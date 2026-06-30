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
	// Shared Keychain access group. The team prefix is resolved at RUNTIME (not hardcoded)
	// so the group always tracks whatever team signs the build - matching the entitlements'
	// $(AppIdentifierPrefix) - and switching Apple accounts can't silently break the
	// app<->extension Keychain sharing the autofill unlock depends on.
	static let accessGroup = "\(appIdentifierPrefix())app.bramble.mobile.shared"

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

	// The app-identifier (team) prefix, e.g. "TEAMID.", read back from the Keychain: an item
	// added without an explicit access group lands in the first keychain-access-group from the
	// entitlements (our shared group), and its kSecAttrAccessGroup carries the resolved prefix.
	// Standard technique; computed once via the `static let` above.
	private static func appIdentifierPrefix() -> String {
		let probe = "app.bramble.mobile.teamprefix-probe"
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: probe,
			kSecAttrAccount as String: probe,
			kSecReturnAttributes as String: true,
			kSecMatchLimit as String: kSecMatchLimitOne,
		]
		var item: CFTypeRef?
		var status = SecItemCopyMatching(query as CFDictionary, &item)
		if status == errSecItemNotFound {
			SecItemAdd(query as CFDictionary, nil)
			status = SecItemCopyMatching(query as CFDictionary, &item)
		}
		guard status == errSecSuccess,
			let attrs = item as? [String: Any],
			let group = attrs[kSecAttrAccessGroup as String] as? String,
			let prefix = group.split(separator: ".").first
		else { return "" }
		return "\(prefix)."
	}
}
