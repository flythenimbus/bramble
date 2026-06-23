import AuthenticationServices
import Capacitor
import Foundation

// Local Capacitor plugin (main-app side) bridging the unlocked vault's autofill index
// to the OS credential provider. For each login it writes the password ENCRYPTED under
// the VEK into the shared App Group, and registers (service, username, recordId) with
// ASCredentialIdentityStore so iOS can show QuickType suggestions while locked. Secrets
// never touch disk in cleartext; the extension reads the biometric-gated VEK (shared
// Keychain) and decrypts only on selection. See docs/mobile-port.md "OS-level autofill".
@objc(AutofillBridgePlugin)
public class AutofillBridgePlugin: CAPPlugin, CAPBridgedPlugin {
	public let identifier = "AutofillBridgePlugin"
	public let jsName = "AutofillBridge"
	public let pluginMethods: [CAPPluginMethod] = [
		CAPPluginMethod(name: "sync", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
	]

	private let appGroup = "group.app.bramble.mobile"
	private let secretsKey = "autofill.secrets"

	// credentials: [{ recordId, username, iv, ciphertext, services: [String] }]. The
	// password ciphertext is encryptWithVek output; the extension decryptWithVek-s it.
	@objc func sync(_ call: CAPPluginCall) {
		let creds = call.getArray("credentials", JSObject.self) ?? []
		var stored: [[String: Any]] = []
		var identities: [ASPasswordCredentialIdentity] = []
		for c in creds {
			guard let recordId = c["recordId"] as? String,
				let username = c["username"] as? String,
				let iv = c["iv"] as? String,
				let ct = c["ciphertext"] as? String
			else { continue }
			let services = (c["services"] as? [String]) ?? []
			stored.append([
				"recordId": recordId, "username": username, "iv": iv, "ciphertext": ct,
				"services": services,
			])
			for svc in services {
				identities.append(
					ASPasswordCredentialIdentity(
						serviceIdentifier: ASCredentialServiceIdentifier(identifier: svc, type: .domain),
						user: username,
						recordIdentifier: recordId))
			}
		}
		// Store as JSON Data: a plist array-of-dicts can fail to cast back cleanly in the
		// extension (NSArray<NSDictionary> -> [[String: Any]]); JSON round-trips exactly.
		let json = (try? JSONSerialization.data(withJSONObject: stored)) ?? Data()
		let defaults = UserDefaults(suiteName: appGroup)
		defaults?.set(json, forKey: secretsKey)
		NSLog("[AutofillBridge] sync wrote %d credentials (%d bytes) to App Group %@",
			stored.count, json.count, appGroup)
		// The identity store is a no-op until the user enables Bramble under Settings.
		ASCredentialIdentityStore.shared.getState { state in
			guard state.isEnabled else {
				call.resolve()
				return
			}
			ASCredentialIdentityStore.shared.replaceCredentialIdentities(with: identities) { _, _ in
				call.resolve()
			}
		}
	}

	@objc func clear(_ call: CAPPluginCall) {
		UserDefaults(suiteName: appGroup)?.removeObject(forKey: secretsKey)
		ASCredentialIdentityStore.shared.removeAllCredentialIdentities { _, _ in call.resolve() }
	}
}
