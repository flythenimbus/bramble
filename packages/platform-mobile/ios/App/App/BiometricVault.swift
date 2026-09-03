import Capacitor
import Foundation
import LocalAuthentication
import Security

// Local Capacitor plugin: caches the vault VEK in the Keychain behind an OS-enforced
// biometric gate. The caller picks the gate per call via `allowPasscode` (the
// "Allow passcode fallback" setting):
//   true  -> .userPresence, released by Face ID / Touch ID OR the device passcode. The only
//            gate a passcode-only device can use.
//   false -> .biometryCurrentSet, biometry only. The item is destroyed by the OS whenever an
//            enrolled face/finger changes, so someone holding the device passcode can't enrol
//            their own biometry and walk in. Matches what Android has always done.
// The ACL is fixed at write time, so the setting is applied by re-arming (see setSecret).
// We never run Argon2 here; this is the device-local convenience-unlock cache described in
// docs/mobile-port.md (Phase 2) and docs/auth-and-unlock.md.
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

	// Keychain work runs HERE, never on the queue Capacitor hands us. The bridge dispatches
	// EVERY plugin call in the app on one serial queue (CapacitorBridge.dispatchQueue, label
	// "bridge"), and a SecItem* call blocks whenever it wants an authentication prompt it cannot
	// present. One such block starves every plugin in the app: a stalled arm-the-gate write is
	// what made an unrelated exportVek time out in Settings. Our own queue contains the damage.
	private static let keychainQueue = DispatchQueue(
		label: "app.bramble.biometric-vault", qos: .userInitiated)

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

	// The un-suffixed item the AutoFill extension USED to read: one cache shared by every vault,
	// so arming a second vault overwrote the first's and disabling either deleted both. The
	// extension now reads the per-vault item directly, keyed by the vault it holds a bundle for
	// (autofill.bundleVaultId), so nothing writes this any more. Kept only to delete it: keychain
	// items survive app deletion, so a stale VEK would otherwise sit there forever.
	private static func legacySharedIdentity() -> [String: Any] {
		[
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: BrambleVault.biometricService,
			kSecAttrAccount as String: BrambleVault.vekAccount,
		]
	}

	// The keep-unlocked session an older build wrote: also un-suffixed, also shared by every
	// vault, and it holds a VEK behind nothing stronger than device-unlock.
	private static func legacySharedSessionIdentity() -> [String: Any] {
		[
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: BrambleVault.sessionService,
			kSecAttrAccount as String: BrambleVault.vekAccount,
		]
	}

	/// Delete what older builds shared between vaults: one cached VEK and one keep-unlocked
	/// session, both un-suffixed, plus the App Group values that described them.
	///
	/// This is a migration, not housekeeping. Nothing reads any of it now, so without this it is
	/// never touched again - and Keychain items outlive the app that wrote them, so it survives
	/// even an uninstall. Both items hold a real VEK. setSecret and purge also drop them, but only
	/// for someone who arms or disarms a gate again; this covers everyone else.
	///
	/// Runs on every launch: deleting something already gone costs one errSecItemNotFound.
	static func purgeLegacySharedItems() {
		keychainQueue.async {
			for identity in [legacySharedIdentity(), legacySharedSessionIdentity()] {
				for q in groupVariants(identity) { SecItemDelete(q as CFDictionary) }
			}
			let defaults = UserDefaults(suiteName: BrambleVault.appGroup)
			// The mirror's vault stamp, needed only while a shared item had to be told apart from
			// the bundle. Keying by vault retired the comparison and the constant with it.
			defaults?.removeObject(forKey: "autofill.biometricVaultId")
			// The un-suffixed flag, replaced by one per vault.
			defaults?.removeObject(forKey: BrambleVault.biometricPasscodeFallbackKey)
		}
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
		// biometryEnrolled tells the UI whether a biometrics-only gate is possible at all:
		// with nothing enrolled, .biometryCurrentSet can't be created and passcode fallback
		// is the only option, so the setting is forced on there.
		call.resolve(["available": ok, "biometryType": type, "biometryEnrolled": enrolled])
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
		Self.keychainQueue.async {
			// UIFail (not UISkip): report the auth-gated item as existing via
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
		// The gate is chosen here, at write time, so changing the setting means re-arming:
		// the settings toggle rewrites the item, and so does every successful unlock while
		// biometric is enabled (which is what converts installs armed by an older build).
		let allowPasscode = call.getBool("allowPasscode") ?? true
		Self.keychainQueue.async {
			var acError: Unmanaged<CFError>?
			guard
				let access = SecAccessControlCreateWithFlags(
					nil,
					kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
					// userPresence = Face ID / Touch ID OR the device passcode (the only gate a
					// passcode-only device can use). biometryCurrentSet = biometry only, and the OS
					// destroys the item when the enrolled set changes.
					allowPasscode ? .userPresence : .biometryCurrentSet,
					&acError
				)
			else {
				// Rarely reached: SecAccessControlCreateWithFlags is lazy, and probing it on the
				// simulator showed .biometryCurrentSet being created happily with NOTHING enrolled -
				// the constraint is only evaluated when the item is read. So this is a backstop, not
				// the thing that stops a biometrics-only gate being armed on a device that can't open
				// one; `effectiveAllowPasscode` on the JS side is what actually prevents that.
				if !allowPasscode {
					call.reject("No biometric is enrolled on this device", "no-biometry")
					return
				}
				call.reject("Couldn't create the biometric access control")
				return
			}
			// One item, this vault's; the AutoFill extension now reads the very same one.
			let status = Self.store(Self.identity(vaultId), data: data, access: access)
			// Drop the shared item an older build wrote. Nothing reads it now, but it holds a real
			// VEK, and keychain items outlive the app that made them.
			for q in Self.groupVariants(Self.legacySharedIdentity()) { SecItemDelete(q as CFDictionary) }
			// Which gate this vault's item carries, so the extension's button doesn't promise a
			// passcode the Keychain will refuse. Written here rather than through AutofillBridge so
			// it can't drift from the access control it describes, and keyed by vault like the item:
			// with two vaults armed at once a single flag names only the one armed last.
			UserDefaults(suiteName: BrambleVault.appGroup)?
				.set(allowPasscode, forKey: "\(BrambleVault.biometricPasscodeFallbackKey):\(vaultId)")
			if status == errSecSuccess {
				call.resolve()
			} else {
				call.reject("Couldn't store the secret (\(status))")
			}
		}
	}

	@objc func getSecret(_ call: CAPPluginCall) {
		guard let vaultId = call.getString("vaultId") else {
			call.reject("Missing vaultId")
			return
		}
		let reason = call.getString("reason") ?? "Unlock your vault"
		let allowPasscode = call.getBool("allowPasscode") ?? true
		let context = LAContext()
		// Authenticate once, then read the protected item reusing that authenticated
		// context (skip the keychain's own prompt). Cleaner cancel detection than the
		// deprecated kSecUseOperationPrompt path. The policy MUST match the gate the item
		// was armed with: a passcode-authenticated context fails a .biometryCurrentSet item.
		if !allowPasscode {
			// ...WithBiometrics still shows a fallback button, but it only reports
			// LAError.userFallback - it cannot authenticate. An empty title hides it, so the
			// prompt doesn't offer a passcode route the user has switched off.
			context.localizedFallbackTitle = ""
		}
		let policy: LAPolicy =
			allowPasscode ? .deviceOwnerAuthentication : .deviceOwnerAuthenticationWithBiometrics
		Self.keychainQueue.async {
			context.evaluatePolicy(policy, localizedReason: reason) {
				success, evalError in
				guard success else {
					let code = (evalError as? LAError)?.code
					if code == .userCancel || code == .appCancel || code == .userFallback {
						call.reject("Cancelled", "cancelled")
					} else if code == .systemCancel {
						// The OS pulled the prompt (app still transitioning, another sheet in the way).
						// Not an answer from anyone, so the caller may ask again.
						call.reject("Interrupted", "interrupted")
					} else if code == .biometryLockout {
						// Too many failed matches. With passcode fallback off there is no way out
						// inside this policy: the device itself has to be unlocked by passcode first.
						call.reject("Biometry is locked out", "lockout")
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
				} else if lastStatus == errSecAuthFailed {
					// The gate authenticated but the item won't decrypt: a .biometryCurrentSet item
					// killed by an enrolment change. It can never open again, so drop it (and the
					// autofill mirror) rather than leave hasSecret advertising a dead gate.
					_ = Self.purge(vaultId)
					call.reject("Biometric enrolment changed; the cached key was discarded", "invalidated")
				} else {
					call.reject("Couldn't read the stored secret (\(lastStatus))", "auth-failed")
				}
			}
		}
	}

	// Remove THIS vault's item, from both groups so no copy lingers, plus the shared item an
	// older build may have left behind. Another vault's gate is untouched: disabling one vault
	// used to delete the shared cache and silently take autofill down for every other.
	// Returns the last status and whether anything is now definitely gone.
	private static func purge(_ vaultId: String) -> (ok: Bool, status: OSStatus) {
		// Clear what described this vault's gate too. Left behind, it tells the extension a gate
		// is armed with a passcode route that no longer exists.
		UserDefaults(suiteName: BrambleVault.appGroup)?
			.removeObject(forKey: "\(BrambleVault.biometricPasscodeFallbackKey):\(vaultId)")
		var lastStatus: OSStatus = errSecItemNotFound
		var ok = false
		for identity in [identity(vaultId), legacySharedIdentity()] {
			for q in groupVariants(identity) {
				let status = SecItemDelete(q as CFDictionary)
				lastStatus = status
				if status == errSecSuccess || status == errSecItemNotFound { ok = true }
			}
		}
		return (ok, lastStatus)
	}

	@objc func deleteSecret(_ call: CAPPluginCall) {
		guard let vaultId = call.getString("vaultId") else {
			call.reject("Missing vaultId")
			return
		}
		Self.keychainQueue.async {
			let (ok, lastStatus) = Self.purge(vaultId)
			if ok {
				call.resolve()
			} else {
				call.reject("Couldn't delete the stored secret (\(lastStatus))")
			}
		}
	}
}

// The storyboard instantiates this subclass (Main.storyboard customClass) so a local
// plugin can be registered the moment the bridge loads.
public class BiometricBridgeViewController: CAPBridgeViewController {
	override public func capacitorDidLoad() {
		// Before anything can read them: see purgeLegacySharedItems.
		BiometricVaultPlugin.purgeLegacySharedItems()
		bridge?.registerPluginInstance(BiometricVaultPlugin())
		bridge?.registerPluginInstance(NativeCryptoPlugin())
		bridge?.registerPluginInstance(NativeWebRTCPlugin())
		bridge?.registerPluginInstance(AutofillBridgePlugin())
		bridge?.registerPluginInstance(QrScannerPlugin())
		bridge?.registerPluginInstance(CredentialExchangePlugin())
	}
}
