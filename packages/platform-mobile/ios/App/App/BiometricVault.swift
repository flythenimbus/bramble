import Capacitor
import Foundation
import LocalAuthentication
import Security

// Local Capacitor plugin: caches the vault VEK in the Keychain behind an OS-enforced
// biometric gate. The item uses a .biometryCurrentSet access control, so the Secure
// Enclave only releases it after a Face ID / Touch ID match and permanently invalidates
// it if the enrolled biometric set changes. We never run Argon2 here; this is the
// device-local convenience-unlock cache described in docs/mobile-port.md (Phase 2).
@objc(BiometricVaultPlugin)
public class BiometricVaultPlugin: CAPPlugin, CAPBridgedPlugin {
	public let identifier = "BiometricVaultPlugin"
	public let jsName = "BiometricVault"
	public let pluginMethods: [CAPPluginMethod] = [
		CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "hasSecret", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "setSecret", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "getSecret", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "deleteSecret", returnType: CAPPluginReturnPromise),
	]

	private let service = "app.bramble.mobile.biometric-vault"
	private let account = "vek"
	// Shared Keychain access group so the AutoFill extension (a separate process)
	// can read the same biometric-gated VEK item. Must match the keychain-access-groups
	// entitlement on both targets (team-prefixed). See docs/mobile-port.md "the crux".
	private let accessGroup = "BHGR3PP64J.app.bramble.mobile.shared"

	@objc func isAvailable(_ call: CAPPluginCall) {
		let context = LAContext()
		var error: NSError?
		let ok = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
		var type = "none"
		if ok {
			switch context.biometryType {
			case .faceID: type = "faceId"
			case .touchID: type = "touchId"
			default: type = "unknown"
			}
		}
		call.resolve(["available": ok, "biometryType": type])
	}

	// Presence check that never triggers a biometric prompt: ask only for attributes
	// (not the protected data) and skip the auth UI.
	@objc func hasSecret(_ call: CAPPluginCall) {
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
				kSecAttrAccessGroup as String: accessGroup,
			kSecReturnData as String: false,
			kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip,
			kSecMatchLimit as String: kSecMatchLimitOne,
		]
		let status = SecItemCopyMatching(query as CFDictionary, nil)
		let present = status == errSecSuccess || status == errSecInteractionNotAllowed
		call.resolve(["value": present])
	}

	@objc func setSecret(_ call: CAPPluginCall) {
		guard let secret = call.getString("secret"), let data = secret.data(using: .utf8) else {
			call.reject("Missing secret")
			return
		}
		let base: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
				kSecAttrAccessGroup as String: accessGroup,
		]
		// Replace any prior (possibly invalidated) item.
		SecItemDelete(base as CFDictionary)

		var acError: Unmanaged<CFError>?
		guard
			let access = SecAccessControlCreateWithFlags(
				nil,
				kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
				.biometryCurrentSet,
				&acError
			)
		else {
			call.reject("Couldn't create the biometric access control")
			return
		}
		var add = base
		add[kSecValueData as String] = data
		add[kSecAttrAccessControl as String] = access
		// Writing the protected item does not require a biometric prompt; only reading does.
		let status = SecItemAdd(add as CFDictionary, nil)
		if status == errSecSuccess {
			call.resolve()
		} else {
			call.reject("Couldn't store the secret (\(status))")
		}
	}

	@objc func getSecret(_ call: CAPPluginCall) {
		let reason = call.getString("reason") ?? "Unlock your vault"
		let context = LAContext()
		// Authenticate once, then read the protected item reusing that authenticated
		// context (skip the keychain's own prompt). Cleaner cancel detection than the
		// deprecated kSecUseOperationPrompt path.
		context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) {
			success, evalError in
			guard success else {
				let code = (evalError as? LAError)?.code
				if code == .userCancel || code == .appCancel || code == .systemCancel {
					call.reject("Cancelled", "cancelled")
				} else {
					call.reject(evalError?.localizedDescription ?? "Authentication failed", "auth-failed")
				}
				return
			}
			let query: [String: Any] = [
				kSecClass as String: kSecClassGenericPassword,
				kSecAttrService as String: self.service,
				kSecAttrAccount as String: self.account,
				kSecAttrAccessGroup as String: self.accessGroup,
				kSecReturnData as String: true,
				kSecMatchLimit as String: kSecMatchLimitOne,
				kSecUseAuthenticationContext as String: context,
				kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip,
			]
			var item: CFTypeRef?
			let status = SecItemCopyMatching(query as CFDictionary, &item)
			if status == errSecSuccess, let data = item as? Data,
				let secret = String(data: data, encoding: .utf8)
			{
				call.resolve(["secret": secret])
			} else if status == errSecItemNotFound {
				call.reject("No biometric secret stored", "no-secret")
			} else {
				call.reject("Couldn't read the stored secret (\(status))", "auth-failed")
			}
		}
	}

	@objc func deleteSecret(_ call: CAPPluginCall) {
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
				kSecAttrAccessGroup as String: accessGroup,
		]
		let status = SecItemDelete(query as CFDictionary)
		if status == errSecSuccess || status == errSecItemNotFound {
			call.resolve()
		} else {
			call.reject("Couldn't delete the stored secret (\(status))")
		}
	}
}

// The storyboard instantiates this subclass (Main.storyboard customClass) so a local
// plugin can be registered the moment the bridge loads.
public class BiometricBridgeViewController: CAPBridgeViewController {
	override public func capacitorDidLoad() {
		bridge?.registerPluginInstance(BiometricVaultPlugin())
		bridge?.registerPluginInstance(NativeCryptoPlugin())
		bridge?.registerPluginInstance(AutofillBridgePlugin())
	}
}
