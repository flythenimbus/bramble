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
		CAPPluginMethod(name: "consumePendingPasskeys", returnType: CAPPluginReturnPromise),
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
		// Passkey bundle (provider role): a second VEK-encrypted blob the extension decrypts
		// to assert. Its own key so the login/password path above is untouched.
		if let pkIv = call.getString("passkeyIv"), let pkCt = call.getString("passkeyCiphertext"),
			let pkData = try? JSONSerialization.data(withJSONObject: ["iv": pkIv, "ciphertext": pkCt])
		{
			defaults?.set(pkData, forKey: BrambleVault.passkeyBundleKey)
		}
		// QuickType identity store: populated only when the user opted into keyboard
		// suggestions (the JS sends identities then). Each carries a domain + username +
		// recordId, never a password; the extension maps the chosen recordId back to the
		// decrypted login. An empty/absent list clears the store (opt-out, or a left-over
		// from an earlier build). Replace wholesale so removed logins don't linger.
		let store = ASCredentialIdentityStore.shared
		let passwords: [ASPasswordCredentialIdentity] = (call.getArray("identities") ?? []).compactMap {
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
		if #available(iOS 17.0, *) {
			// Passkey identities (NOT gated on QuickType: the OS can't route a passkey sign-in
			// to a provider whose credentials it doesn't know). Metadata only; credentialID /
			// userHandle arrive as STANDARD base64, exactly what ASPasskeyCredentialIdentity
			// wants as Data. recordIdentifier = credentialId so the extension can look it up.
			let passkeys: [ASPasskeyCredentialIdentity] = (call.getArray("passkeyIdentities") ?? [])
				.compactMap {
					guard let d = $0 as? [String: Any],
						let rp = d["rpId"] as? String,
						let cid = d["credentialId"] as? String, let credID = Data(base64Encoded: cid),
						let uh = d["userHandle"] as? String, let userHandle = Data(base64Encoded: uh)
					else { return nil }
					return ASPasskeyCredentialIdentity(
						relyingPartyIdentifier: rp, userName: (d["userName"] as? String) ?? "",
						credentialID: credID, userHandle: userHandle, recordIdentifier: cid)
				}
			// One-time-code identities (iOS 18+). Behind the SAME opt-in as the password ones: they
			// carry a domain + label in the clear, which also reveals WHICH sites have 2FA. The code
			// itself is generated in the extension from the VEK-encrypted seed, never stored here.
			// Declared in here, not at method scope: ASCredentialIdentity is itself iOS 17+.
			var oneTimeCodes: [ASCredentialIdentity] = []
			if #available(iOS 18.0, *) {
				oneTimeCodes = (call.getArray("oneTimeCodeIdentities") ?? []).compactMap {
					guard let d = $0 as? [String: Any],
						let service = d["service"] as? String,
						let label = d["label"] as? String,
						let rid = d["recordId"] as? String
					else { return nil }
					return ASOneTimeCodeCredentialIdentity(
						serviceIdentifier: ASCredentialServiceIdentifier(identifier: service, type: .domain),
						label: label, recordIdentifier: rid)
				}
			}
			// One replace for ALL kinds: replaceCredentialIdentities clears the WHOLE store, so
			// passwords + passkeys + codes must go together or a second call would wipe the first.
			let all: [ASCredentialIdentity] = passwords + passkeys + oneTimeCodes
			store.getState { state in
				guard state.isEnabled else { return }
				Task { try? await store.replaceCredentialIdentities(all) }
			}
		} else {
			store.getState { state in
				guard state.isEnabled else { return }
				store.replaceCredentialIdentities(with: passwords) { _, _ in }
			}
		}
		call.resolve()
	}

	// Drain the passkeys the AutoFill extension minted during sign-in registrations (it can't
	// write the vault itself). Returns the VEK-encrypted entries and clears them; the app
	// decrypts and merges them into the vault. See CredentialProviderViewController.stashPending.
	@objc func consumePendingPasskeys(_ call: CAPPluginCall) {
		let defaults = UserDefaults(suiteName: BrambleVault.appGroup)
		let pending =
			(defaults?.array(forKey: BrambleVault.pendingPasskeysKey) as? [[String: String]]) ?? []
		defaults?.removeObject(forKey: BrambleVault.pendingPasskeysKey)
		call.resolve(["pending": pending])
	}

	@objc func clear(_ call: CAPPluginCall) {
		let defaults = UserDefaults(suiteName: BrambleVault.appGroup)
		defaults?.removeObject(forKey: BrambleVault.bundleKey)
		defaults?.removeObject(forKey: BrambleVault.slotKey)
		defaults?.removeObject(forKey: BrambleVault.passkeyBundleKey)
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
