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
	// Shared Keychain access group. Resolved from THIS build's own signed entitlements, so the
	// team prefix always matches whatever team signed the build (the entitlements'
	// $(AppIdentifierPrefix)) and the app<->extension Keychain sharing the autofill/biometric
	// unlock depends on never breaks. Read straight from the entitlement (not by probing the
	// Keychain) so it can't be poisoned by a locked-Keychain probe on first access.
	static let accessGroup = resolveSharedAccessGroup()

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

	private static let sharedGroupSuffix = ".app.bramble.mobile.shared"

	// Prefer the app's own `keychain-access-groups` entitlement: Xcode resolves $(AppIdentifierPrefix)
	// into it at signing, so it already holds the exact string iOS will accept (e.g.
	// "TEAMID.app.bramble.mobile.shared") and is readable in any lock state - unlike a Keychain
	// probe, which returns errSecMissingEntitlement (-34018) if it runs while the Keychain is
	// locked. The probe below is only a fallback; if both fail we return the un-prefixed group and
	// the Keychain writers fall back to no access group, so in-app biometric unlock still works.
	private static func resolveSharedAccessGroup() -> String {
		let entitledGroups = SecTaskCreateFromSelf(nil).flatMap {
			SecTaskCopyValueForEntitlement($0, "keychain-access-groups" as CFString, nil) as? [String]
		}
		if let shared = entitledGroups?.first(where: { $0.hasSuffix(sharedGroupSuffix) }) {
			return shared
		}
		if let prefix = probeTeamPrefix() {
			return "\(prefix)app.bramble.mobile.shared"
		}
		return "app.bramble.mobile.shared"
	}

	// Fallback prefix resolver: an item added without an explicit access group lands in our first
	// keychain-access-group, whose id carries the resolved team prefix. Skips com.apple.token and
	// returns nil (never a poisoned empty prefix) on any failure.
	private static func probeTeamPrefix() -> String? {
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
			group != "com.apple.token",
			let prefix = group.split(separator: ".").first
		else { return nil }
		return "\(prefix)."
	}
}
