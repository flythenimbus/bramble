import AuthenticationServices
import Capacitor
import Foundation
import Security

// Local Capacitor plugin (main-app side) bridging the unlocked vault's login list to the
// OS credential provider. The whole list (names, usernames, passwords) arrives already
// encrypted under the VEK and is stored as an opaque blob in the shared App Group, so the
// extension reveals nothing about the vault until the user authenticates and can decrypt
// it. We also store the (non-secret) password slot so the extension can unlock itself
// with the master password. No cleartext entry data lands in the App Group. The OS
// QuickType identity store (usernames + domains, no passwords) is populated only when the
// user opts into keyboard suggestions; off by default. docs/mobile-port.md.
@objc(AutofillBridgePlugin)
public class AutofillBridgePlugin: CAPPlugin, CAPBridgedPlugin {
	public let identifier = "AutofillBridgePlugin"
	public let jsName = "AutofillBridge"
	public let pluginMethods: [CAPPluginMethod] = [
		CAPPluginMethod(name: "sync", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "setKeepUnlocked", returnType: CAPPluginReturnPromise),
	]

	// Shared identifiers (App Group, Keychain group, keys) live in BrambleVault, compiled
	// into both this target and the AutoFill extension so the two processes can't drift.

	// iv/ciphertext = encryptWithVek over the JSON login list. Opaque without the VEK.
	@objc func sync(_ call: CAPPluginCall) {
		let defaults = UserDefaults(suiteName: BrambleVault.appGroup)
		if let iv = call.getString("iv"), let ct = call.getString("ciphertext"),
			let data = try? JSONSerialization.data(withJSONObject: ["iv": iv, "ciphertext": ct])
		{
			defaults?.set(data, forKey: BrambleVault.bundleKey)
		}
		// The password slot lets the extension unlock itself with the master password.
		// Non-secret (the wrappedVek stays AES-encrypted); store as JSON Data.
		if let slot = call.getObject("slot"),
			let slotJson = try? JSONSerialization.data(withJSONObject: slot)
		{
			defaults?.set(slotJson, forKey: BrambleVault.slotKey)
		}
		// QuickType identity store: populated only when the user opted into keyboard
		// suggestions (the JS sends identities then). Each carries a domain + username +
		// recordId, never a password; the extension maps the chosen recordId back to the
		// decrypted login. An empty/absent list clears the store (opt-out, or a left-over
		// from an earlier build). Replace wholesale so removed logins don't linger.
		let store = ASCredentialIdentityStore.shared
		let identities: [ASPasswordCredentialIdentity] = (call.getArray("identities") ?? []).compactMap {
			guard let d = $0 as? [String: Any],
				let service = d["service"] as? String,
				let user = d["username"] as? String,
				let rid = d["recordId"] as? String
			else { return nil }
			return ASPasswordCredentialIdentity(
				serviceIdentifier: ASCredentialServiceIdentifier(identifier: service, type: .domain),
				user: user, recordIdentifier: rid)
		}
		// Replace atomically (an empty list clears the store). saveCredentialIdentities is an
		// upsert and removeAll-then-save can race iOS's indexing; replaceCredentialIdentities
		// does both in one step. It silently no-ops unless the user has enabled Bramble as an
		// AutoFill provider, so guard on the store state (and so QuickType only populates once
		// the provider is actually on).
		store.getState { state in
			guard state.isEnabled else { return }
			store.replaceCredentialIdentities(with: identities) { _, _ in }
		}
		call.resolve()
	}

	@objc func clear(_ call: CAPPluginCall) {
		let defaults = UserDefaults(suiteName: BrambleVault.appGroup)
		defaults?.removeObject(forKey: BrambleVault.bundleKey)
		defaults?.removeObject(forKey: BrambleVault.slotKey)
		ASCredentialIdentityStore.shared.removeAllCredentialIdentities { _, _ in call.resolve() }
	}

	// How long the autofill extension may stay unlocked without re-auth (0 = off).
	// Turning it off clears any live cached session immediately.
	@objc func setKeepUnlocked(_ call: CAPPluginCall) {
		let minutes = call.getInt("minutes") ?? 0
		UserDefaults(suiteName: BrambleVault.appGroup)?.set(minutes, forKey: BrambleVault.keepUnlockedKey)
		if minutes == 0 {
			SecItemDelete(
				[
					kSecClass as String: kSecClassGenericPassword,
					kSecAttrService as String: BrambleVault.sessionService,
					kSecAttrAccount as String: BrambleVault.vekAccount,
					kSecAttrAccessGroup as String: BrambleVault.accessGroup,
				] as CFDictionary)
		}
		call.resolve()
	}
}
