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

    @PluginMethod
    fun encryptWithVek(call: PluginCall) {
        val pt = str(call, "plaintext") ?: return
        call.runCrypto {
            val p = uniffi.vault_crypto.encryptWithVek(pt)
            call.resolve(JSObject().put("iv", p.iv).put("ciphertext", p.ciphertext))
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
}
