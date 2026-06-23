import Capacitor
import Foundation

// Local Capacitor plugin bridging the shared Rust crypto core (uniffi, in
// VaultCryptoFFI) to the webview. Replaces the in-webview WASM crypto on device:
// native code needs no JIT, so the vault creates/unlocks under iOS Lockdown Mode
// (WASM does not), and the autofill extension links the same core. The uniffi
// free functions (generateVek(), unlockWithVek(_:), ...) live at App-module scope;
// the plugin methods below shadow them by name, so the uniffi functions are reached
// module-qualified as `App.<fn>` (App = this target's module). See docs/mobile-port.md.
@objc(NativeCryptoPlugin)
public class NativeCryptoPlugin: CAPPlugin, CAPBridgedPlugin {
	public let identifier = "NativeCryptoPlugin"
	public let jsName = "NativeCrypto"
	public let pluginMethods: [CAPPluginMethod] = [
		CAPPluginMethod(name: "isLocked", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "lock", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "generateVek", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "unlockWithVek", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "exportVek", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "rotateVek", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "generateSalt", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "generateSlotId", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "wrapVekPassword", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "unwrapVekPassword", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "verifyPasswordSlot", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "wrapVekWebauthn", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "unwrapVekWebauthn", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "verifyWebauthnSlot", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "encryptEntry", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "decryptEntry", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "encryptWithVek", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "decryptWithVek", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "openKdbx4", returnType: CAPPluginReturnPromise),
	]

	// --- helpers ---

	// Surface a uniffi error to JS as its message; for crypto/KDBX errors that is the
	// stable code string (e.g. "KDBX_WRONG_CREDENTIAL") the TS layer switches on.
	private func fail(_ call: CAPPluginCall, _ error: Error) {
		if case let CryptoError.Crypto(message) = error {
			call.reject(message)
		} else {
			call.reject(error.localizedDescription)
		}
	}

	private func str(_ call: CAPPluginCall, _ key: String) -> String? {
		guard let v = call.getString(key) else {
			call.reject("Missing \(key)")
			return nil
		}
		return v
	}

	// magicVersion / file bytes cross the bridge as base64 (JSON has no byte arrays).
	private func bytes(_ call: CAPPluginCall, _ key: String) -> Data? {
		guard let s = call.getString(key), let d = Data(base64Encoded: s) else {
			call.reject("Missing or invalid \(key)")
			return nil
		}
		return d
	}

	private func blobJs(_ b: PasswordSlotBlob) -> [String: Any] {
		["verifier": b.verifier, "wrapIv": b.wrapIv, "wrappedVek": b.wrappedVek]
	}

	// --- VEK lifecycle ---

	@objc func isLocked(_ call: CAPPluginCall) { call.resolve(["value": App.isLocked()]) }

	@objc func lock(_ call: CAPPluginCall) {
		App.lock()
		call.resolve()
	}

	@objc func generateVek(_ call: CAPPluginCall) {
		do { call.resolve(["value": try App.generateVek()]) } catch { fail(call, error) }
	}

	@objc func unlockWithVek(_ call: CAPPluginCall) {
		guard let vek = str(call, "vekB64") else { return }
		do { try App.unlockWithVek(vekB64: vek); call.resolve() } catch { fail(call, error) }
	}

	@objc func exportVek(_ call: CAPPluginCall) {
		do { call.resolve(["value": try App.exportVek()]) } catch { fail(call, error) }
	}

	@objc func rotateVek(_ call: CAPPluginCall) {
		do { call.resolve(["value": try App.rotateVek()]) } catch { fail(call, error) }
	}

	@objc func generateSalt(_ call: CAPPluginCall) {
		do { call.resolve(["value": try App.generateSalt()]) } catch { fail(call, error) }
	}

	@objc func generateSlotId(_ call: CAPPluginCall) {
		do { call.resolve(["value": try App.generateSlotId()]) } catch { fail(call, error) }
	}

	// --- password slots ---

	@objc func wrapVekPassword(_ call: CAPPluginCall) {
		guard let pw = str(call, "password"), let salt = str(call, "saltB64"),
			let slot = str(call, "slotIdB64"), let mv = bytes(call, "magicVersionB64") else { return }
		do {
			let b = try App.wrapVekPassword(password: pw, saltB64: salt, slotIdB64: slot, magicVersion: mv)
			call.resolve(blobJs(b))
		} catch { fail(call, error) }
	}

	@objc func unwrapVekPassword(_ call: CAPPluginCall) {
		guard let pw = str(call, "password"), let salt = str(call, "saltB64"),
			let slot = str(call, "slotIdB64"), let verifier = str(call, "verifierB64"),
			let wrapIv = str(call, "wrapIvB64"), let wrapped = str(call, "wrappedVekB64"),
			let mv = bytes(call, "magicVersionB64") else { return }
		do {
			let ok = try App.unwrapVekPassword(
				password: pw, saltB64: salt, slotIdB64: slot, verifierB64: verifier,
				wrapIvB64: wrapIv, wrappedVekB64: wrapped, magicVersion: mv)
			call.resolve(["value": ok])
		} catch { fail(call, error) }
	}

	@objc func verifyPasswordSlot(_ call: CAPPluginCall) {
		guard let pw = str(call, "password"), let salt = str(call, "saltB64"),
			let slot = str(call, "slotIdB64"), let verifier = str(call, "verifierB64"),
			let mv = bytes(call, "magicVersionB64") else { return }
		do {
			let ok = try App.verifyPasswordSlot(
				password: pw, saltB64: salt, slotIdB64: slot, verifierB64: verifier, magicVersion: mv)
			call.resolve(["value": ok])
		} catch { fail(call, error) }
	}

	// --- webauthn slots ---

	@objc func wrapVekWebauthn(_ call: CAPPluginCall) {
		guard let secret = str(call, "hmacSecretB64"), let slot = str(call, "slotIdB64"),
			let mv = bytes(call, "magicVersionB64") else { return }
		do {
			let b = try App.wrapVekWebauthn(hmacSecretB64: secret, slotIdB64: slot, magicVersion: mv)
			call.resolve(blobJs(b))
		} catch { fail(call, error) }
	}

	@objc func unwrapVekWebauthn(_ call: CAPPluginCall) {
		guard let secret = str(call, "hmacSecretB64"), let slot = str(call, "slotIdB64"),
			let verifier = str(call, "verifierB64"), let wrapIv = str(call, "wrapIvB64"),
			let wrapped = str(call, "wrappedVekB64"), let mv = bytes(call, "magicVersionB64") else { return }
		do {
			let ok = try App.unwrapVekWebauthn(
				hmacSecretB64: secret, slotIdB64: slot, verifierB64: verifier,
				wrapIvB64: wrapIv, wrappedVekB64: wrapped, magicVersion: mv)
			call.resolve(["value": ok])
		} catch { fail(call, error) }
	}

	@objc func verifyWebauthnSlot(_ call: CAPPluginCall) {
		guard let secret = str(call, "hmacSecretB64"), let slot = str(call, "slotIdB64"),
			let verifier = str(call, "verifierB64"), let mv = bytes(call, "magicVersionB64") else { return }
		do {
			let ok = try App.verifyWebauthnSlot(
				hmacSecretB64: secret, slotIdB64: slot, verifierB64: verifier, magicVersion: mv)
			call.resolve(["value": ok])
		} catch { fail(call, error) }
	}

	// --- entry encryption ---

	@objc func encryptEntry(_ call: CAPPluginCall) {
		guard let json = str(call, "plaintextJson") else { return }
		do {
			let p = try App.encryptEntry(plaintextJson: json)
			call.resolve(["ciphertext": p.ciphertext, "iv": p.iv, "wrappedDek": p.wrappedDek, "dekIv": p.dekIv])
		} catch { fail(call, error) }
	}

	@objc func decryptEntry(_ call: CAPPluginCall) {
		guard let ct = str(call, "ciphertext"), let iv = str(call, "iv"),
			let wd = str(call, "wrappedDek"), let di = str(call, "dekIv") else { return }
		do {
			call.resolve(["value": try App.decryptEntry(ciphertext: ct, iv: iv, wrappedDek: wd, dekIv: di)])
		} catch { fail(call, error) }
	}

	@objc func encryptWithVek(_ call: CAPPluginCall) {
		guard let pt = str(call, "plaintext") else { return }
		do {
			let p = try App.encryptWithVek(plaintext: pt)
			call.resolve(["iv": p.iv, "ciphertext": p.ciphertext])
		} catch { fail(call, error) }
	}

	@objc func decryptWithVek(_ call: CAPPluginCall) {
		guard let iv = str(call, "ivB64"), let ct = str(call, "ciphertextB64") else { return }
		do {
			call.resolve(["value": try App.decryptWithVek(ivB64: iv, ciphertextB64: ct)])
		} catch { fail(call, error) }
	}

	// --- KDBX4 import ---

	@objc func openKdbx4(_ call: CAPPluginCall) {
		guard let file = bytes(call, "fileB64"), let pw = str(call, "password") else { return }
		let keyfile = call.getString("keyfileB64").flatMap { Data(base64Encoded: $0) }
		do {
			let entries = try App.openKdbx4(file: file, password: pw, keyfile: keyfile)
			let js = entries.map { e in
				["strings": e.strings.map { ["key": $0.key, "value": $0.value, "protected": $0.protected] }]
			}
			call.resolve(["entries": js])
		} catch { fail(call, error) }
	}
}
