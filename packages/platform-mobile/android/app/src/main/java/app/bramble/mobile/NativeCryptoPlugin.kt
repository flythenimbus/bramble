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

    // Surface a uniffi error to JS as its bare code (e.g. "KDBX_WRONG_CREDENTIAL"), so the
    // TS layer switches on the same stable codes it gets from the iOS plugin. Reading the
    // variant's own `msg` avoids the "msg=<code>" wrapper uniffi puts on Throwable.message.
    private fun fail(call: PluginCall, e: Throwable) {
        call.reject(if (e is CryptoException.Crypto) e.msg else e.message ?: e.toString())
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

    // --- VEK lifecycle ---

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
    fun generateVek(call: PluginCall) {
        try {
            call.resolve(JSObject().put("value", uniffi.vault_crypto.generateVek()))
        } catch (e: CryptoException) {
            fail(call, e)
        }
    }

    @PluginMethod
    fun unlockWithVek(call: PluginCall) {
        val vek = str(call, "vekB64") ?: return
        try {
            uniffi.vault_crypto.unlockWithVek(vek)
            call.resolve()
        } catch (e: CryptoException) {
            fail(call, e)
        }
    }

    @PluginMethod
    fun exportVek(call: PluginCall) {
        try {
            call.resolve(JSObject().put("value", uniffi.vault_crypto.exportVek()))
        } catch (e: CryptoException) {
            fail(call, e)
        }
    }

    @PluginMethod
    fun rotateVek(call: PluginCall) {
        try {
            call.resolve(JSObject().put("value", uniffi.vault_crypto.rotateVek()))
        } catch (e: CryptoException) {
            fail(call, e)
        }
    }

    @PluginMethod
    fun generateSalt(call: PluginCall) {
        try {
            call.resolve(JSObject().put("value", uniffi.vault_crypto.generateSalt()))
        } catch (e: CryptoException) {
            fail(call, e)
        }
    }

    @PluginMethod
    fun generateSlotId(call: PluginCall) {
        try {
            call.resolve(JSObject().put("value", uniffi.vault_crypto.generateSlotId()))
        } catch (e: CryptoException) {
            fail(call, e)
        }
    }

    // --- password slots ---

    @PluginMethod
    fun wrapVekPassword(call: PluginCall) {
        val pw = str(call, "password") ?: return
        val salt = str(call, "saltB64") ?: return
        val slot = str(call, "slotIdB64") ?: return
        val mv = bytes(call, "magicVersionB64") ?: return
        try {
            call.resolve(blobJs(uniffi.vault_crypto.wrapVekPassword(pw, salt, slot, mv)))
        } catch (e: CryptoException) {
            fail(call, e)
        }
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
        try {
            val ok = uniffi.vault_crypto.unwrapVekPassword(pw, salt, slot, verifier, wrapIv, wrapped, mv)
            call.resolve(JSObject().put("value", ok))
        } catch (e: CryptoException) {
            fail(call, e)
        }
    }

    @PluginMethod
    fun verifyPasswordSlot(call: PluginCall) {
        val pw = str(call, "password") ?: return
        val salt = str(call, "saltB64") ?: return
        val slot = str(call, "slotIdB64") ?: return
        val verifier = str(call, "verifierB64") ?: return
        val mv = bytes(call, "magicVersionB64") ?: return
        try {
            val ok = uniffi.vault_crypto.verifyPasswordSlot(pw, salt, slot, verifier, mv)
            call.resolve(JSObject().put("value", ok))
        } catch (e: CryptoException) {
            fail(call, e)
        }
    }

    // --- webauthn slots ---

    @PluginMethod
    fun wrapVekWebauthn(call: PluginCall) {
        val secret = str(call, "hmacSecretB64") ?: return
        val slot = str(call, "slotIdB64") ?: return
        val mv = bytes(call, "magicVersionB64") ?: return
        try {
            call.resolve(blobJs(uniffi.vault_crypto.wrapVekWebauthn(secret, slot, mv)))
        } catch (e: CryptoException) {
            fail(call, e)
        }
    }

    @PluginMethod
    fun unwrapVekWebauthn(call: PluginCall) {
        val secret = str(call, "hmacSecretB64") ?: return
        val slot = str(call, "slotIdB64") ?: return
        val verifier = str(call, "verifierB64") ?: return
        val wrapIv = str(call, "wrapIvB64") ?: return
        val wrapped = str(call, "wrappedVekB64") ?: return
        val mv = bytes(call, "magicVersionB64") ?: return
        try {
            val ok = uniffi.vault_crypto.unwrapVekWebauthn(secret, slot, verifier, wrapIv, wrapped, mv)
            call.resolve(JSObject().put("value", ok))
        } catch (e: CryptoException) {
            fail(call, e)
        }
    }

    @PluginMethod
    fun verifyWebauthnSlot(call: PluginCall) {
        val secret = str(call, "hmacSecretB64") ?: return
        val slot = str(call, "slotIdB64") ?: return
        val verifier = str(call, "verifierB64") ?: return
        val mv = bytes(call, "magicVersionB64") ?: return
        try {
            val ok = uniffi.vault_crypto.verifyWebauthnSlot(secret, slot, verifier, mv)
            call.resolve(JSObject().put("value", ok))
        } catch (e: CryptoException) {
            fail(call, e)
        }
    }

    // --- entry encryption ---

    @PluginMethod
    fun encryptEntry(call: PluginCall) {
        val json = str(call, "plaintextJson") ?: return
        try {
            val p = uniffi.vault_crypto.encryptEntry(json)
            call.resolve(
                JSObject()
                    .put("ciphertext", p.ciphertext)
                    .put("iv", p.iv)
                    .put("wrappedDek", p.wrappedDek)
                    .put("dekIv", p.dekIv)
            )
        } catch (e: CryptoException) {
            fail(call, e)
        }
    }

    @PluginMethod
    fun decryptEntry(call: PluginCall) {
        val ct = str(call, "ciphertext") ?: return
        val iv = str(call, "iv") ?: return
        val wd = str(call, "wrappedDek") ?: return
        val di = str(call, "dekIv") ?: return
        try {
            call.resolve(JSObject().put("value", uniffi.vault_crypto.decryptEntry(ct, iv, wd, di)))
        } catch (e: CryptoException) {
            fail(call, e)
        }
    }

    @PluginMethod
    fun encryptWithVek(call: PluginCall) {
        val pt = str(call, "plaintext") ?: return
        try {
            val p = uniffi.vault_crypto.encryptWithVek(pt)
            call.resolve(JSObject().put("iv", p.iv).put("ciphertext", p.ciphertext))
        } catch (e: CryptoException) {
            fail(call, e)
        }
    }

    @PluginMethod
    fun decryptWithVek(call: PluginCall) {
        val iv = str(call, "ivB64") ?: return
        val ct = str(call, "ciphertextB64") ?: return
        try {
            call.resolve(JSObject().put("value", uniffi.vault_crypto.decryptWithVek(iv, ct)))
        } catch (e: CryptoException) {
            fail(call, e)
        }
    }

    // --- KDBX4 import ---

    @PluginMethod
    fun openKdbx4(call: PluginCall) {
        val file = bytes(call, "fileB64") ?: return
        val pw = str(call, "password") ?: return
        val keyfile = call.getString("keyfileB64")?.let { Base64.decode(it, Base64.NO_WRAP) }
        try {
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
        } catch (e: CryptoException) {
            fail(call, e)
        }
    }
}
