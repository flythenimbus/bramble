package app.bramble.mobile

import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import uniffi.vault_crypto.CryptoException
import uniffi.vault_crypto.PasswordSlotBlob

// Local Capacitor plugin bridging the shared Rust crypto core (uniffi, in jniLibs +
// the generated uniffi.vault_crypto glue) to the webview. The Android peer of iOS
// NativeCrypto.swift: same JS surface (registered as "NativeCrypto"), so the shared
// native-crypto.ts adapter drives either platform unchanged. The uniffi free functions
// are reached package-qualified as `uniffi.vault_crypto.<fn>` (this plugin's methods
// share their names but differ by signature). Byte args (magicVersion, KDBX files)
// cross the bridge as base64. Capacitor runs @PluginMethod off the main thread, so the
// Argon2id-bearing calls (wrap/unwrap/verify password, openKdbx4) don't risk an ANR.
// See docs/mobile-port.md.
@CapacitorPlugin(name = "NativeCrypto")
class NativeCryptoPlugin : Plugin() {

    // --- helpers ---

    // Run a crypto call, rejecting the JS promise on failure. CryptoException.Crypto
    // stringifies its message as "msg=<code>", so surface the bare `.msg` (e.g.
    // "KDBX_WRONG_CREDENTIAL") the TS layer switches on, matching the iOS plugin. Any
    // other throwable (e.g. a JNA/FFI error) is surfaced rather than crashing the bridge.
    private inline fun PluginCall.runCrypto(block: () -> Unit) {
        try {
            block()
        } catch (e: CryptoException.Crypto) {
            reject(e.msg)
        } catch (e: Throwable) {
            reject(e.message ?: e.toString())
        }
    }

    private fun str(call: PluginCall, key: String): String? {
        val v = call.getString(key)
        if (v == null) call.reject("Missing $key")
        return v
    }

    // magicVersion / file bytes cross the bridge as base64 (JSON has no byte arrays).
    private fun bytes(call: PluginCall, key: String): ByteArray? {
        val s = call.getString(key)
        if (s == null) {
            call.reject("Missing or invalid $key")
            return null
        }
        return try {
            Base64.decode(s, Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            call.reject("Missing or invalid $key")
            null
        }
    }

    private fun blobJs(b: PasswordSlotBlob): JSObject =
        JSObject().put("verifier", b.verifier).put("wrapIv", b.wrapIv).put("wrappedVek", b.wrappedVek)

    // Noise session ids are u32 handles minted in Rust; they round-trip as JS numbers.
    private fun u32(call: PluginCall, key: String): UInt? {
        val v = call.getInt(key)
        if (v == null) call.reject("Missing $key")
        return v?.toUInt()
    }

    // --- VEK lifecycle (isLocked/lock are non-throwing in the core) ---

    @PluginMethod
    fun isLocked(call: PluginCall) {
        call.resolve(JSObject().put("value", uniffi.vault_crypto.isLocked()))
    }

    @PluginMethod
    fun lock(call: PluginCall) {
        uniffi.vault_crypto.lock()
        call.resolve()
    }

    @PluginMethod
    fun generateVek(call: PluginCall) = call.runCrypto {
        call.resolve(JSObject().put("value", uniffi.vault_crypto.generateVek()))
    }

    @PluginMethod
    fun unlockWithVek(call: PluginCall) {
        val vek = str(call, "vekB64") ?: return
        call.runCrypto {
            uniffi.vault_crypto.unlockWithVek(vek)
            call.resolve()
        }
    }

    @PluginMethod
    fun exportVek(call: PluginCall) = call.runCrypto {
        call.resolve(JSObject().put("value", uniffi.vault_crypto.exportVek()))
    }

    @PluginMethod
    fun rotateVek(call: PluginCall) = call.runCrypto {
        call.resolve(JSObject().put("value", uniffi.vault_crypto.rotateVek()))
    }

    @PluginMethod
    fun generateSalt(call: PluginCall) = call.runCrypto {
        call.resolve(JSObject().put("value", uniffi.vault_crypto.generateSalt()))
    }

    @PluginMethod
    fun generateSlotId(call: PluginCall) = call.runCrypto {
        call.resolve(JSObject().put("value", uniffi.vault_crypto.generateSlotId()))
    }

    // --- password slots ---

    @PluginMethod
    fun wrapVekPassword(call: PluginCall) {
        val pw = str(call, "password") ?: return
        val salt = str(call, "saltB64") ?: return
        val slot = str(call, "slotIdB64") ?: return
        val mv = bytes(call, "magicVersionB64") ?: return
        call.runCrypto { call.resolve(blobJs(uniffi.vault_crypto.wrapVekPassword(pw, salt, slot, mv))) }
    }

    @PluginMethod
    fun unwrapVekPassword(call: PluginCall) {
        val pw = str(call, "password") ?: return
        val salt = str(call, "saltB64") ?: return
        val slot = str(call, "slotIdB64") ?: return
        val verifier = str(call, "verifierB64") ?: return
        val wrapIv = str(call, "wrapIvB64") ?: return
        val wrapped = str(call, "wrappedVekB64") ?: return
        val mv = bytes(call, "magicVersionB64") ?: return
        call.runCrypto {
            val ok = uniffi.vault_crypto.unwrapVekPassword(pw, salt, slot, verifier, wrapIv, wrapped, mv)
            call.resolve(JSObject().put("value", ok))
        }
    }

    @PluginMethod
    fun verifyPasswordSlot(call: PluginCall) {
        val pw = str(call, "password") ?: return
        val salt = str(call, "saltB64") ?: return
        val slot = str(call, "slotIdB64") ?: return
        val verifier = str(call, "verifierB64") ?: return
        val mv = bytes(call, "magicVersionB64") ?: return
        call.runCrypto {
            val ok = uniffi.vault_crypto.verifyPasswordSlot(pw, salt, slot, verifier, mv)
            call.resolve(JSObject().put("value", ok))
        }
    }

    // --- webauthn slots ---

    @PluginMethod
    fun wrapVekWebauthn(call: PluginCall) {
        val secret = str(call, "hmacSecretB64") ?: return
        val slot = str(call, "slotIdB64") ?: return
        val mv = bytes(call, "magicVersionB64") ?: return
        call.runCrypto { call.resolve(blobJs(uniffi.vault_crypto.wrapVekWebauthn(secret, slot, mv))) }
    }

    @PluginMethod
    fun unwrapVekWebauthn(call: PluginCall) {
        val secret = str(call, "hmacSecretB64") ?: return
        val slot = str(call, "slotIdB64") ?: return
        val verifier = str(call, "verifierB64") ?: return
        val wrapIv = str(call, "wrapIvB64") ?: return
        val wrapped = str(call, "wrappedVekB64") ?: return
        val mv = bytes(call, "magicVersionB64") ?: return
        call.runCrypto {
            val ok = uniffi.vault_crypto.unwrapVekWebauthn(secret, slot, verifier, wrapIv, wrapped, mv)
            call.resolve(JSObject().put("value", ok))
        }
    }

    @PluginMethod
    fun verifyWebauthnSlot(call: PluginCall) {
        val secret = str(call, "hmacSecretB64") ?: return
        val slot = str(call, "slotIdB64") ?: return
        val verifier = str(call, "verifierB64") ?: return
        val mv = bytes(call, "magicVersionB64") ?: return
        call.runCrypto {
            val ok = uniffi.vault_crypto.verifyWebauthnSlot(secret, slot, verifier, mv)
            call.resolve(JSObject().put("value", ok))
        }
    }

    // --- entry encryption ---

    @PluginMethod
    fun encryptEntry(call: PluginCall) {
        val json = str(call, "plaintextJson") ?: return
        call.runCrypto {
            val p = uniffi.vault_crypto.encryptEntry(json)
            call.resolve(
                JSObject()
                    .put("ciphertext", p.ciphertext)
                    .put("iv", p.iv)
                    .put("wrappedDek", p.wrappedDek)
                    .put("dekIv", p.dekIv)
            )
        }
    }

    @PluginMethod
    fun decryptEntry(call: PluginCall) {
        val ct = str(call, "ciphertext") ?: return
        val iv = str(call, "iv") ?: return
        val wd = str(call, "wrappedDek") ?: return
        val di = str(call, "dekIv") ?: return
        call.runCrypto {
            call.resolve(JSObject().put("value", uniffi.vault_crypto.decryptEntry(ct, iv, wd, di)))
        }
    }

    // Decrypt the whole vault in one bridge call: loop over the entries natively
    // (each uniffi call is in-process) instead of crossing the JS<->native boundary
    // per entry. runCrypto (off the main thread) rejects if any entry fails.
    @PluginMethod
    fun decryptEntries(call: PluginCall) {
        val entries = call.getArray("entries")
        if (entries == null) {
            call.reject("Missing entries")
            return
        }
        call.runCrypto {
            val values = JSArray()
            for (i in 0 until entries.length()) {
                val e = entries.getJSONObject(i)
                values.put(
                    uniffi.vault_crypto.decryptEntry(
                        e.getString("ciphertext"),
                        e.getString("iv"),
                        e.getString("wrappedDek"),
                        e.getString("dekIv"),
                    ),
                )
            }
            call.resolve(JSObject().put("values", values))
        }
    }

    @PluginMethod
    fun encryptWithVek(call: PluginCall) {
        val pt = str(call, "plaintext") ?: return
        call.runCrypto {
            val p = uniffi.vault_crypto.encryptWithVek(pt)
            call.resolve(JSObject().put("iv", p.iv).put("ciphertext", p.ciphertext))
        }
    }

    // --- portable vault (.bramble export/import) ---
    // Sealed under a key the core generates per file, so neither call reads or writes the
    // session VEK; both work on a locked vault.

    @PluginMethod
    fun sealPortableVault(call: PluginCall) {
        val json = str(call, "entriesJson") ?: return
        val pw = str(call, "password") ?: return
        val mv = bytes(call, "magicVersionB64") ?: return
        call.runCrypto {
            val v = uniffi.vault_crypto.sealPortableVault(json, pw, mv)
            call.resolve(
                JSObject()
                    .put("slotId", v.slotId)
                    .put("salt", v.salt)
                    .put("verifier", v.verifier)
                    .put("wrapIv", v.wrapIv)
                    .put("wrappedVek", v.wrappedVek)
                    .put("entriesIv", v.entriesIv)
                    .put("entriesCiphertext", v.entriesCiphertext)
            )
        }
    }

    @PluginMethod
    fun openPortableVault(call: PluginCall) {
        val pw = str(call, "password") ?: return
        val mv = bytes(call, "magicVersionB64") ?: return
        val f = call.getObject("file")
        if (f == null) {
            call.reject("Missing file")
            return
        }
        // getString is nullable: a field missing from the bridged object would otherwise
        // reach Rust as an empty string and fail as a decode error rather than a clear one.
        val file =
            try {
                fun field(key: String) = requireNotNull(f.getString(key)) { key }
                uniffi.vault_crypto.PortableVault(
                    slotId = field("slotId"),
                    salt = field("salt"),
                    verifier = field("verifier"),
                    wrapIv = field("wrapIv"),
                    wrappedVek = field("wrappedVek"),
                    entriesIv = field("entriesIv"),
                    entriesCiphertext = field("entriesCiphertext"),
                )
            } catch (e: IllegalArgumentException) {
                call.reject("portable vault file is malformed")
                return
            }
        call.runCrypto {
            // null is a wrong password, a normal answer rather than an error.
            val json = uniffi.vault_crypto.openPortableVault(pw, file, mv)
            call.resolve(JSObject().put("value", json))
        }
    }

    @PluginMethod
    fun decryptWithVek(call: PluginCall) {
        val iv = str(call, "ivB64") ?: return
        val ct = str(call, "ciphertextB64") ?: return
        call.runCrypto {
            call.resolve(JSObject().put("value", uniffi.vault_crypto.decryptWithVek(iv, ct)))
        }
    }

    // --- passkey import ---

    @PluginMethod
    fun passkeyImportPkcs8(call: PluginCall) {
        val pkcs8 = str(call, "pkcs8B64") ?: return
        call.runCrypto {
            val imported = uniffi.vault_crypto.passkeyImportPkcs8(pkcs8)
            // `alg` is not optional: the entry schema requires it, and a passkey missing it is
            // dropped along with its whole login on import.
            call.resolve(
                JSObject()
                    .put("privateKey", imported.privateKey)
                    .put("publicKeyCose", imported.publicKeyCose)
                    .put("alg", imported.alg)
            )
        }
    }

    // --- KDBX4 import ---

    @PluginMethod
    fun openKdbx4(call: PluginCall) {
        val file = bytes(call, "fileB64") ?: return
        val pw = str(call, "password") ?: return
        val keyfile = call.getString("keyfileB64")?.let { Base64.decode(it, Base64.NO_WRAP) }
        call.runCrypto {
            val entries = uniffi.vault_crypto.openKdbx4(file, pw, keyfile)
            val arr = JSArray()
            for (e in entries) {
                val strings = JSArray()
                for (s in e.strings) {
                    strings.put(
                        JSObject().put("key", s.key).put("value", s.value).put("protected", s.`protected`)
                    )
                }
                arr.put(JSObject().put("strings", strings))
            }
            call.resolve(JSObject().put("entries", arr))
        }
    }

    // --- sync transport: Noise handshake (KK + XXpsk3) ---

    @PluginMethod
    fun handshakeGenerateKeypair(call: PluginCall) = call.runCrypto {
        val k = uniffi.vault_crypto.handshakeGenerateKeypair()
        call.resolve(JSObject().put("privateKey", k.privateKey).put("publicKey", k.publicKey))
    }

    @PluginMethod
    fun handshakeStartInitiator(call: PluginCall) {
        val priv = str(call, "localPrivB64") ?: return
        val remote = str(call, "remotePubB64") ?: return
        call.runCrypto {
            val s = uniffi.vault_crypto.handshakeStartInitiator(priv, remote)
            call.resolve(JSObject().put("sessionId", s.sessionId.toLong()).put("message", s.message))
        }
    }

    @PluginMethod
    fun handshakeStartResponder(call: PluginCall) {
        val priv = str(call, "localPrivB64") ?: return
        val remote = str(call, "remotePubB64") ?: return
        call.runCrypto {
            val id = uniffi.vault_crypto.handshakeStartResponder(priv, remote)
            call.resolve(JSObject().put("value", id.toLong()))
        }
    }

    @PluginMethod
    fun handshakeEnrollInitiator(call: PluginCall) {
        val priv = str(call, "localPrivB64") ?: return
        val psk = str(call, "pskB64") ?: return
        call.runCrypto {
            val s = uniffi.vault_crypto.handshakeEnrollInitiator(priv, psk)
            call.resolve(JSObject().put("sessionId", s.sessionId.toLong()).put("message", s.message))
        }
    }

    @PluginMethod
    fun handshakeEnrollResponder(call: PluginCall) {
        val priv = str(call, "localPrivB64") ?: return
        val psk = str(call, "pskB64") ?: return
        call.runCrypto {
            val id = uniffi.vault_crypto.handshakeEnrollResponder(priv, psk)
            call.resolve(JSObject().put("value", id.toLong()))
        }
    }

    @PluginMethod
    fun handshakeRead(call: PluginCall) {
        val sid = u32(call, "sessionId") ?: return
        val msg = str(call, "messageB64") ?: return
        call.runCrypto {
            val r = uniffi.vault_crypto.handshakeRead(sid, msg)
            val out = JSObject().put("done", r.done)
            if (r.message != null) out.put("message", r.message) // absent -> JS undefined
            call.resolve(out)
        }
    }

    @PluginMethod
    fun handshakeEncrypt(call: PluginCall) {
        val sid = u32(call, "sessionId") ?: return
        val pt = str(call, "plaintext") ?: return
        call.runCrypto {
            call.resolve(JSObject().put("value", uniffi.vault_crypto.handshakeEncrypt(sid, pt)))
        }
    }

    @PluginMethod
    fun handshakeDecrypt(call: PluginCall) {
        val sid = u32(call, "sessionId") ?: return
        val ct = str(call, "ciphertextB64") ?: return
        call.runCrypto {
            call.resolve(JSObject().put("value", uniffi.vault_crypto.handshakeDecrypt(sid, ct)))
        }
    }

    @PluginMethod
    fun handshakeRemoteStatic(call: PluginCall) {
        val sid = u32(call, "sessionId") ?: return
        call.runCrypto {
            call.resolve(JSObject().put("value", uniffi.vault_crypto.handshakeRemoteStatic(sid)))
        }
    }

    @PluginMethod
    fun handshakeClose(call: PluginCall) {
        val sid = u32(call, "sessionId") ?: return
        uniffi.vault_crypto.handshakeClose(sid)
        call.resolve()
    }

    // --- sync transport: Nostr (BIP340) ---

    @PluginMethod
    fun nostrGenerateKey(call: PluginCall) = call.runCrypto {
        val k = uniffi.vault_crypto.nostrGenerateKey()
        call.resolve(JSObject().put("secretKey", k.secretKey).put("publicKey", k.publicKey))
    }

    @PluginMethod
    fun nostrPublicKey(call: PluginCall) {
        val secret = str(call, "secretB64") ?: return
        call.runCrypto {
            call.resolve(JSObject().put("value", uniffi.vault_crypto.nostrPublicKey(secret)))
        }
    }

    @PluginMethod
    fun nostrSign(call: PluginCall) {
        val secret = str(call, "secretB64") ?: return
        val hash = str(call, "hashB64") ?: return
        call.runCrypto {
            call.resolve(JSObject().put("value", uniffi.vault_crypto.nostrSign(secret, hash)))
        }
    }

    @PluginMethod
    fun nostrVerify(call: PluginCall) {
        val pub = str(call, "publicB64") ?: return
        val hash = str(call, "hashB64") ?: return
        val sig = str(call, "sigB64") ?: return
        call.runCrypto {
            call.resolve(JSObject().put("value", uniffi.vault_crypto.nostrVerify(pub, hash, sig)))
        }
    }

    // --- roster-entry signing (Ed25519) + password-authority admission (Item A) ---

    @PluginMethod
    fun rosterSigGenerateKey(call: PluginCall) = call.runCrypto {
        val k = uniffi.vault_crypto.rosterSigGenerateKey()
        call.resolve(JSObject().put("secretKey", k.secretKey).put("publicKey", k.publicKey))
    }

    @PluginMethod
    fun rosterSigPublicKey(call: PluginCall) {
        val secret = str(call, "secretB64") ?: return
        call.runCrypto {
            call.resolve(JSObject().put("value", uniffi.vault_crypto.rosterSigPublicKey(secret)))
        }
    }

    @PluginMethod
    fun rosterSign(call: PluginCall) {
        val secret = str(call, "secretB64") ?: return
        val message = str(call, "message") ?: return
        call.runCrypto {
            call.resolve(JSObject().put("value", uniffi.vault_crypto.rosterSign(secret, message)))
        }
    }

    @PluginMethod
    fun rosterVerify(call: PluginCall) {
        val pub = str(call, "publicB64") ?: return
        val message = str(call, "message") ?: return
        val sig = str(call, "sigB64") ?: return
        call.runCrypto {
            call.resolve(JSObject().put("value", uniffi.vault_crypto.rosterVerify(pub, message, sig)))
        }
    }

    @PluginMethod
    fun rosterAdmissionPublicKey(call: PluginCall) {
        val password = str(call, "password") ?: return
        val salt = str(call, "saltB64") ?: return
        call.runCrypto {
            call.resolve(
                JSObject().put("value", uniffi.vault_crypto.rosterAdmissionPublicKey(password, salt))
            )
        }
    }

    @PluginMethod
    fun rosterAdmissionSign(call: PluginCall) {
        val password = str(call, "password") ?: return
        val salt = str(call, "saltB64") ?: return
        val message = str(call, "message") ?: return
        call.runCrypto {
            call.resolve(
                JSObject().put(
                    "value",
                    uniffi.vault_crypto.rosterAdmissionSign(password, salt, message)
                )
            )
        }
    }
}
