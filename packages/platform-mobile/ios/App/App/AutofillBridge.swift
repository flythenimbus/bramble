import AuthenticationServices
import Capacitor
import Foundation
import Security

// Local Capacitor plugin (main-app side) bridging the unlocked vault's login list to the
// OS credential provider. The whole list (names, usernames, passwords) arrives already
// encrypted under the VEK and is stored as an opaque blob in the shared App Group, so the
// extension reveals nothing about the vault until the user authenticates and can decrypt
// it. We also store the (non-secret) password slot so the extension can unlock itself
// with the master password. No cleartext entry data, and no ASCredentialIdentityStore
// (that would surface usernames in QuickType before auth). docs/mobile-port.md.
@objc(AutofillBridgePlugin)
public class AutofillBridgePlugin: CAPPlugin, CAPBridgedPlugin {
	public let identifier = "AutofillBridgePlugin"
	public let jsName = "AutofillBridge"
	public let pluginMethods: [CAPPluginMethod] = [
		CAPPluginMethod(name: "sync", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "setKeepUnlocked", returnType: CAPPluginReturnPromise),
	]

	private let appGroup = "group.app.bramble.mobile"
	private let bundleKey = "autofill.bundle"
	private let slotKey = "autofill.slot"
	private let keepUnlockedKey = "autofill.keepUnlockedMinutes"
	private let sessionService = "app.bramble.mobile.autofill-session"
	private let accessGroup = "BHGR3PP64J.app.bramble.mobile.shared"

	// iv/ciphertext = encryptWithVek over the JSON login list. Opaque without the VEK.
	@objc func sync(_ call: CAPPluginCall) {
		let defaults = UserDefaults(suiteName: appGroup)
		if let iv = call.getString("iv"), let ct = call.getString("ciphertext"),
			let data = try? JSONSerialization.data(withJSONObject: ["iv": iv, "ciphertext": ct])
		{
			defaults?.set(data, forKey: bundleKey)
		}
		// The password slot lets the extension unlock itself with the master password.
		// Non-secret (the wrappedVek stays AES-encrypted); store as JSON Data.
		if let slot = call.getObject("slot"),
			let slotJson = try? JSONSerialization.data(withJSONObject: slot)
		{
			defaults?.set(slotJson, forKey: slotKey)
		}
		// Never populate the identity store: QuickType identities expose usernames before
		// the user authenticates. Clear any left over from earlier builds.
		ASCredentialIdentityStore.shared.removeAllCredentialIdentities { _, _ in }
		call.resolve()
	}

	@objc func clear(_ call: CAPPluginCall) {
		let defaults = UserDefaults(suiteName: appGroup)
		defaults?.removeObject(forKey: bundleKey)
		defaults?.removeObject(forKey: slotKey)
		ASCredentialIdentityStore.shared.removeAllCredentialIdentities { _, _ in call.resolve() }
	}

	// How long the autofill extension may stay unlocked without re-auth (0 = off).
	// Turning it off clears any live cached session immediately.
	@objc func setKeepUnlocked(_ call: CAPPluginCall) {
		let minutes = call.getInt("minutes") ?? 0
		UserDefaults(suiteName: appGroup)?.set(minutes, forKey: keepUnlockedKey)
		if minutes == 0 {
			SecItemDelete(
				[
					kSecClass as String: kSecClassGenericPassword,
					kSecAttrService as String: sessionService,
					kSecAttrAccount as String: "vek",
					kSecAttrAccessGroup as String: accessGroup,
				] as CFDictionary)
		}
		call.resolve()
	}
}
