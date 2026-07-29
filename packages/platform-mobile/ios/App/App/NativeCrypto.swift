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
		CAPPluginMethod(name: "decryptEntries", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "encryptWithVek", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "decryptWithVek", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "passkeyImportPkcs8", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "openKdbx4", returnType: CAPPluginReturnPromise),
		// Sync transport: Noise handshake (KK roster-auth + XXpsk3 enrollment) + Nostr.
		CAPPluginMethod(name: "handshakeGenerateKeypair", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "handshakeStartInitiator", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "handshakeStartResponder", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "handshakeEnrollInitiator", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "handshakeEnrollResponder", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "handshakeRead", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "handshakeEncrypt", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "handshakeDecrypt", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "handshakeRemoteStatic", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "handshakeClose", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "nostrGenerateKey", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "nostrPublicKey", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "nostrSign", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "nostrVerify", returnType: CAPPluginReturnPromise),
		// Roster-entry signing (Ed25519) + password-authority admission (Item A).
		CAPPluginMethod(name: "rosterSigGenerateKey", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "rosterSigPublicKey", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "rosterSign", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "rosterVerify", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "rosterAdmissionPublicKey", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "rosterAdmissionSign", returnType: CAPPluginReturnPromise),
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

	// Noise session ids are u32 handles minted in Rust; they round-trip as JS numbers.
	private func u32(_ call: CAPPluginCall, _ key: String) -> UInt32? {
		guard let v = call.getInt(key) else {
			call.reject("Missing \(key)")
			return nil
		}
		return UInt32(truncatingIfNeeded: v)
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

	// Decrypt the whole vault in one bridge call: loop over the entries natively
	// (each uniffi call is in-process) instead of crossing the bridge per entry.
	@objc func decryptEntries(_ call: CAPPluginCall) {
		let entries = call.getArray("entries") ?? []
		do {
			var values: [String] = []
			values.reserveCapacity(entries.count)
			for item in entries {
				guard let d = item as? [String: Any],
					let ct = d["ciphertext"] as? String, let iv = d["iv"] as? String,
					let wd = d["wrappedDek"] as? String, let di = d["dekIv"] as? String
				else {
					call.reject("Malformed entry in decryptEntries")
					return
				}
				values.append(try App.decryptEntry(ciphertext: ct, iv: iv, wrappedDek: wd, dekIv: di))
			}
			call.resolve(["values": values])
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

	// --- passkey import ---

	@objc func passkeyImportPkcs8(_ call: CAPPluginCall) {
		guard let pkcs8 = str(call, "pkcs8B64") else { return }
		do {
			let imported = try App.passkeyImportPkcs8(pkcs8B64: pkcs8)
			call.resolve(["privateKey": imported.privateKey, "publicKeyCose": imported.publicKeyCose])
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

	// --- sync transport: Noise handshake ---

	@objc func handshakeGenerateKeypair(_ call: CAPPluginCall) {
		do {
			let k = try App.handshakeGenerateKeypair()
			call.resolve(["privateKey": k.privateKey, "publicKey": k.publicKey])
		} catch { fail(call, error) }
	}

	@objc func handshakeStartInitiator(_ call: CAPPluginCall) {
		guard let priv = str(call, "localPrivB64"), let remote = str(call, "remotePubB64") else { return }
		do {
			let s = try App.handshakeStartInitiator(localPrivB64: priv, remotePubB64: remote)
			call.resolve(["sessionId": Int(s.sessionId), "message": s.message])
		} catch { fail(call, error) }
	}

	@objc func handshakeStartResponder(_ call: CAPPluginCall) {
		guard let priv = str(call, "localPrivB64"), let remote = str(call, "remotePubB64") else { return }
		do {
			let id = try App.handshakeStartResponder(localPrivB64: priv, remotePubB64: remote)
			call.resolve(["value": Int(id)])
		} catch { fail(call, error) }
	}

	@objc func handshakeEnrollInitiator(_ call: CAPPluginCall) {
		guard let priv = str(call, "localPrivB64"), let psk = str(call, "pskB64") else { return }
		do {
			let s = try App.handshakeEnrollInitiator(localPrivB64: priv, pskB64: psk)
			call.resolve(["sessionId": Int(s.sessionId), "message": s.message])
		} catch { fail(call, error) }
	}

	@objc func handshakeEnrollResponder(_ call: CAPPluginCall) {
		guard let priv = str(call, "localPrivB64"), let psk = str(call, "pskB64") else { return }
		do {
			let id = try App.handshakeEnrollResponder(localPrivB64: priv, pskB64: psk)
			call.resolve(["value": Int(id)])
		} catch { fail(call, error) }
	}

	@objc func handshakeRead(_ call: CAPPluginCall) {
		guard let sid = u32(call, "sessionId"), let msg = str(call, "messageB64") else { return }
		do {
			let r = try App.handshakeRead(sessionId: sid, messageB64: msg)
			var out: [String: Any] = ["done": r.done]
			if let m = r.message { out["message"] = m } // absent -> JS undefined
			call.resolve(out)
		} catch { fail(call, error) }
	}

	@objc func handshakeEncrypt(_ call: CAPPluginCall) {
		guard let sid = u32(call, "sessionId"), let pt = str(call, "plaintext") else { return }
		do {
			call.resolve(["value": try App.handshakeEncrypt(sessionId: sid, plaintext: pt)])
		} catch { fail(call, error) }
	}

	@objc func handshakeDecrypt(_ call: CAPPluginCall) {
		guard let sid = u32(call, "sessionId"), let ct = str(call, "ciphertextB64") else { return }
		do {
			call.resolve(["value": try App.handshakeDecrypt(sessionId: sid, ciphertextB64: ct)])
		} catch { fail(call, error) }
	}

	@objc func handshakeRemoteStatic(_ call: CAPPluginCall) {
		guard let sid = u32(call, "sessionId") else { return }
		do {
			call.resolve(["value": try App.handshakeRemoteStatic(sessionId: sid)])
		} catch { fail(call, error) }
	}

	@objc func handshakeClose(_ call: CAPPluginCall) {
		guard let sid = u32(call, "sessionId") else { return }
		App.handshakeClose(sessionId: sid)
		call.resolve()
	}

	// --- sync transport: Nostr (BIP340) ---

	@objc func nostrGenerateKey(_ call: CAPPluginCall) {
		do {
			let k = try App.nostrGenerateKey()
			call.resolve(["secretKey": k.secretKey, "publicKey": k.publicKey])
		} catch { fail(call, error) }
	}

	@objc func nostrPublicKey(_ call: CAPPluginCall) {
		guard let secret = str(call, "secretB64") else { return }
		do {
			call.resolve(["value": try App.nostrPublicKey(secretB64: secret)])
		} catch { fail(call, error) }
	}

	@objc func nostrSign(_ call: CAPPluginCall) {
		guard let secret = str(call, "secretB64"), let hash = str(call, "hashB64") else { return }
		do {
			call.resolve(["value": try App.nostrSign(secretB64: secret, hashB64: hash)])
		} catch { fail(call, error) }
	}

	@objc func nostrVerify(_ call: CAPPluginCall) {
		guard let pub = str(call, "publicB64"), let hash = str(call, "hashB64"),
			let sig = str(call, "sigB64") else { return }
		do {
			call.resolve(["value": try App.nostrVerify(publicB64: pub, hashB64: hash, sigB64: sig)])
		} catch { fail(call, error) }
	}

	// --- roster-entry signing (Ed25519) + password-authority admission (Item A) ---

	@objc func rosterSigGenerateKey(_ call: CAPPluginCall) {
		do {
			let k = try App.rosterSigGenerateKey()
			call.resolve(["secretKey": k.secretKey, "publicKey": k.publicKey])
		} catch { fail(call, error) }
	}

	@objc func rosterSigPublicKey(_ call: CAPPluginCall) {
		guard let secret = str(call, "secretB64") else { return }
		do {
			call.resolve(["value": try App.rosterSigPublicKey(secretB64: secret)])
		} catch { fail(call, error) }
	}

	@objc func rosterSign(_ call: CAPPluginCall) {
		guard let secret = str(call, "secretB64"), let message = str(call, "message") else { return }
		do {
			call.resolve(["value": try App.rosterSign(secretB64: secret, message: message)])
		} catch { fail(call, error) }
	}

	@objc func rosterVerify(_ call: CAPPluginCall) {
		guard let pub = str(call, "publicB64"), let message = str(call, "message"),
			let sig = str(call, "sigB64") else { return }
		do {
			call.resolve(["value": try App.rosterVerify(publicB64: pub, message: message, sigB64: sig)])
		} catch { fail(call, error) }
	}

	@objc func rosterAdmissionPublicKey(_ call: CAPPluginCall) {
		guard let password = str(call, "password"), let salt = str(call, "saltB64") else { return }
		do {
			call.resolve(["value": try App.rosterAdmissionPublicKey(password: password, saltB64: salt)])
		} catch { fail(call, error) }
	}

	@objc func rosterAdmissionSign(_ call: CAPPluginCall) {
		guard let password = str(call, "password"), let salt = str(call, "saltB64"),
			let message = str(call, "message") else { return }
		do {
			call.resolve([
				"value": try App.rosterAdmissionSign(password: password, saltB64: salt, message: message)
			])
		} catch { fail(call, error) }
	}
}
