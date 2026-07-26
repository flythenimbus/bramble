import Capacitor
import Foundation
import LocalAuthentication
import Security

// Local Capacitor plugin: caches the vault VEK in the Keychain behind an OS-enforced
// user-presence gate. The item uses .userPresence, so the Secure Enclave releases it on a
// Face ID / Touch ID match OR the device passcode; that fallback is what lets a
// passcode-only device (and the AutoFill extension) unlock. We never run Argon2 here; this
// is the device-local convenience-unlock cache described in docs/mobile-port.md (Phase 2).
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

	// The biometric VEK item identity for one vault (service + per-vault account, no access group).
	// Each vault gets its own item (account `vek:<vaultId>`), so enabling biometric on one vault
	// never overwrites another's cached VEK - the in-app unlock is per-vault.
	private static func identity(_ vaultId: String) -> [String: Any] {
		[
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: BrambleVault.biometricService,
			kSecAttrAccount as String: "\(BrambleVault.vekAccount):\(vaultId)",
		]
	}

	// The un-suffixed item the AutoFill extension reads: it runs out-of-process and can't know the
	// app's active vault id, so setSecret mirrors the (active) vault's VEK here and deleteSecret
	// clears it. Effectively autofill follows the active vault; per-vault autofill data is Tier 2.
	private static func autofillIdentity() -> [String: Any] {
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
		// deviceOwnerAuthentication = biometry OR passcode, so a device with no enrolled
		// biometric still gets the fast unlock. It reports "passcode" for the UI copy.
		let ok = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
		var bioError: NSError?
		let bioReady = context.canEvaluatePolicy(
			.deviceOwnerAuthenticationWithBiometrics, error: &bioError)
		// Locked out still means enrolled: keep naming the device's biometry, since the
		// passcode fallback is what carries the unlock until the lockout clears.
		let enrolled = bioReady || (bioError as? LAError)?.code == .biometryLockout
		var type = "none"
		if ok {
			type = enrolled ? Self.biometryName(context) : "passcode"
		}
		call.resolve(["available": ok, "biometryType": type])
	}

	// LAContext.biometryType is only meaningful once canEvaluatePolicy has run.
	private static func biometryName(_ context: LAContext) -> String {
		// .opticID is iOS 17+; guard it since the deployment target is 15.0.
		if #available(iOS 17.0, *), context.biometryType == .opticID {
			return "opticId"
		}
		switch context.biometryType {
		case .faceID: return "faceId"
		case .touchID: return "touchId"
		default: return "unknown"
		}
	}

	// Presence check that never triggers a biometric prompt: ask only for attributes
	// (not the protected data) and skip the auth UI.
	@objc func hasSecret(_ call: CAPPluginCall) {
		guard let vaultId = call.getString("vaultId") else {
			call.reject("Missing vaultId")
			return
		}
		// UIFail (not UISkip): report the .userPresence item as existing via
		// errSecInteractionNotAllowed instead of silently skipping it (which returns
		// errSecItemNotFound and made the toggle revert). Neither prompts for Face ID.
		let query = Self.identity(vaultId).merging([
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

	// Store `data` under `identity`, behind the biometric access control. Replaces any prior copy in
	// either group; prefers the shared group (extension-readable), falling back to the app's default
	// group when the shared-group entitlement isn't usable (errSecMissingEntitlement, -34018).
	// Writing the protected item does not require a biometric prompt; only reading does.
	private static func store(_ identity: [String: Any], data: Data, access: SecAccessControl)
		-> OSStatus
	{
		for q in groupVariants(identity) { SecItemDelete(q as CFDictionary) }
		var add = identity
		add[kSecValueData as String] = data
		add[kSecAttrAccessControl as String] = access
		var status = SecItemAdd(withAccessGroup(add) as CFDictionary, nil)
		if status == errSecMissingEntitlement {
			status = SecItemAdd(add as CFDictionary, nil)
		}
		return status
	}

	@objc func setSecret(_ call: CAPPluginCall) {
		guard let vaultId = call.getString("vaultId") else {
			call.reject("Missing vaultId")
			return
		}
		guard let secret = call.getString("secret"), let data = secret.data(using: .utf8) else {
			call.reject("Missing secret")
			return
		}
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
		// Per-vault item (the in-app unlock reads this) + the shared un-suffixed mirror the AutoFill
		// extension reads. The per-vault write is authoritative; the mirror is best-effort.
		let status = Self.store(Self.identity(vaultId), data: data, access: access)
		_ = Self.store(Self.autofillIdentity(), data: data, access: access)
		if status == errSecSuccess {
			call.resolve()
		} else {
			call.reject("Couldn't store the secret (\(status))")
		}
	}

	@objc func getSecret(_ call: CAPPluginCall) {
		guard let vaultId = call.getString("vaultId") else {
			call.reject("Missing vaultId")
			return
		}
		let reason = call.getString("reason") ?? "Unlock your vault"
		let context = LAContext()
		// Authenticate once, then read the protected item reusing that authenticated
		// context (skip the keychain's own prompt). Cleaner cancel detection than the
		// deprecated kSecUseOperationPrompt path. The policy must stay
		// deviceOwnerAuthentication (not ...WithBiometrics) to match the item's
		// .userPresence gate: passcode-only devices have no other way in, and a
		// passcode-authenticated context would fail a .biometryCurrentSet item.
		context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) {
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
			let query = Self.identity(vaultId).merging([
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
		guard let vaultId = call.getString("vaultId") else {
			call.reject("Missing vaultId")
			return
		}
		// Remove this vault's per-vault item AND the shared autofill mirror, from both groups so no
		// copy lingers. Clearing the mirror stops autofill until biometric is re-enabled (re-armed).
		var lastStatus: OSStatus = errSecItemNotFound
		var ok = false
		for identity in [Self.identity(vaultId), Self.autofillIdentity()] {
			for q in Self.groupVariants(identity) {
				let status = SecItemDelete(q as CFDictionary)
				lastStatus = status
				if status == errSecSuccess || status == errSecItemNotFound { ok = true }
			}
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
