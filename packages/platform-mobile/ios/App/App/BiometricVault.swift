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

	// service / account / accessGroup live in BrambleVault (shared with the AutoFill
	// extension and the keychain-access-groups entitlement). See docs/mobile-port.md.

	// The biometric VEK item identity (service + account, no access group).
	private static func identity() -> [String: Any] {
		[
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: BrambleVault.biometricService,
			kSecAttrAccount as String: BrambleVault.vekAccount,
		]
	}

	// Add the shared access group to a query. The iOS Simulator's keychain doesn't support access
	// groups (a query carrying kSecAttrAccessGroup fails with -34018), so omit it there.
	private static func withAccessGroup(_ query: [String: Any]) -> [String: Any] {
		#if targetEnvironment(simulator)
			return query
		#else
			var q = query
			q[kSecAttrAccessGroup as String] = BrambleVault.accessGroup
			return q
		#endif
	}

	// Every operation tries TWO group variants: the shared group first (so the AutoFill extension
	// can read the same item), then the app's default group. The shared-group write returns
	// errSecMissingEntitlement (-34018) whenever a build's signing doesn't actually grant the
	// keychain-access-group; the default group always works, so in-app biometric unlock keeps
	// working regardless (only cross-process autofill sharing needs the shared group).
	private static func groupVariants(_ query: [String: Any]) -> [[String: Any]] {
		[withAccessGroup(query), query]
	}

	@objc func isAvailable(_ call: CAPPluginCall) {
		let context = LAContext()
		var error: NSError?
		let ok = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
		var type = "none"
		if ok {
			// .opticID is iOS 17+; guard it since the deployment target is 15.0.
			if #available(iOS 17.0, *), context.biometryType == .opticID {
				type = "opticId"
			} else {
				switch context.biometryType {
				case .faceID: type = "faceId"
				case .touchID: type = "touchId"
				default: type = "unknown"
				}
			}
		}
		call.resolve(["available": ok, "biometryType": type])
	}

	// Presence check that never triggers a biometric prompt: ask only for attributes
	// (not the protected data) and skip the auth UI.
	@objc func hasSecret(_ call: CAPPluginCall) {
		// UIFail (not UISkip): report the .userPresence item as existing via
		// errSecInteractionNotAllowed instead of silently skipping it (which returns
		// errSecItemNotFound and made the toggle revert). Neither prompts for Face ID.
		let query = Self.identity().merging([
			kSecReturnData as String: false,
			kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
			kSecMatchLimit as String: kSecMatchLimitOne,
		]) { _, new in new }
		var present = false
		for q in Self.groupVariants(query) {
			let status = SecItemCopyMatching(q as CFDictionary, nil)
			if status == errSecSuccess || status == errSecInteractionNotAllowed {
				present = true
				break
			}
		}
		call.resolve(["value": present])
	}

	@objc func setSecret(_ call: CAPPluginCall) {
		guard let secret = call.getString("secret"), let data = secret.data(using: .utf8) else {
			call.reject("Missing secret")
			return
		}
		// Replace any prior (possibly invalidated) copy in either group.
		for q in Self.groupVariants(Self.identity()) { SecItemDelete(q as CFDictionary) }

		var acError: Unmanaged<CFError>?
		guard
			let access = SecAccessControlCreateWithFlags(
				nil,
				kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
				// userPresence = Face ID / Touch ID, with device-passcode fallback. Lets the
				// AutoFill extension read the cached VEK even when biometrics aren't enrolled,
				// and keeps the in-app unlock working via biometrics.
				.userPresence,
				&acError
			)
		else {
			call.reject("Couldn't create the biometric access control")
			return
		}
		var add = Self.identity()
		add[kSecValueData as String] = data
		add[kSecAttrAccessControl as String] = access
		// Writing the protected item does not require a biometric prompt; only reading does. Prefer
		// the shared group (extension can read it); fall back to the app's default group when the
		// shared-group entitlement isn't usable on this build (errSecMissingEntitlement, -34018), so
		// in-app biometric unlock still works.
		var status = SecItemAdd(Self.withAccessGroup(add) as CFDictionary, nil)
		if status == errSecMissingEntitlement {
			status = SecItemAdd(add as CFDictionary, nil)
		}
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
			let query = Self.identity().merging([
				kSecReturnData as String: true,
				kSecMatchLimit as String: kSecMatchLimitOne,
				kSecUseAuthenticationContext as String: context,
				kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip,
			]) { _, new in new }
			var lastStatus: OSStatus = errSecItemNotFound
			for q in Self.groupVariants(query) {
				var item: CFTypeRef?
				let status = SecItemCopyMatching(q as CFDictionary, &item)
				if status == errSecSuccess, let data = item as? Data,
					let secret = String(data: data, encoding: .utf8)
				{
					call.resolve(["secret": secret])
					return
				}
				lastStatus = status
			}
			if lastStatus == errSecItemNotFound {
				call.reject("No biometric secret stored", "no-secret")
			} else {
				call.reject("Couldn't read the stored secret (\(lastStatus))", "auth-failed")
			}
		}
	}

	@objc func deleteSecret(_ call: CAPPluginCall) {
		// Remove the item from both groups so no copy lingers.
		var lastStatus: OSStatus = errSecItemNotFound
		var ok = false
		for q in Self.groupVariants(Self.identity()) {
			let status = SecItemDelete(q as CFDictionary)
			lastStatus = status
			if status == errSecSuccess || status == errSecItemNotFound { ok = true }
		}
		if ok {
			call.resolve()
		} else {
			call.reject("Couldn't delete the stored secret (\(lastStatus))")
		}
	}
}

// The storyboard instantiates this subclass (Main.storyboard customClass) so a local
// plugin can be registered the moment the bridge loads.
public class BiometricBridgeViewController: CAPBridgeViewController {
	override public func capacitorDidLoad() {
		bridge?.registerPluginInstance(BiometricVaultPlugin())
		bridge?.registerPluginInstance(NativeCryptoPlugin())
		bridge?.registerPluginInstance(NativeWebRTCPlugin())
		bridge?.registerPluginInstance(AutofillBridgePlugin())
		bridge?.registerPluginInstance(QrScannerPlugin())
	}
}
