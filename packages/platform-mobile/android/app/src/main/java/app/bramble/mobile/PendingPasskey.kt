package app.bramble.mobile

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import uniffi.vault_crypto.encryptWithVek

// Create-side handoff for the Credential Manager passkey provider. The fulfill activity mints a
// passkey but must NOT write the vault (single-writer + sync HLC stamping live in the main app),
// so it stashes the new credential here - VEK-encrypted, so the private key is never at rest in
// clear - and the app drains + persists it on next launch (core usePendingPasskeys). Mirrors
// PendingSave and the iOS App Group handoff. The file lives in the app-private filesDir that
// Capacitor's Directory.Data reads. See docs/passkey-provider.md.
object PendingPasskey {
    const val FILE = "autofill_pending_passkeys.json"

    // `credentialJson` is a full PasskeyCredential (mirrors core's). The caller MUST have the VEK
    // loaded (it just unlocked to mint). Appends so multiple creates before a launch all survive.
    fun write(context: Context, credentialJson: String) {
        val enc = encryptWithVek(credentialJson)
        val file = File(context.filesDir, FILE)
        val arr = try {
            if (file.exists()) JSONArray(file.readText()) else JSONArray()
        } catch (e: Exception) {
            JSONArray()
        }
        arr.put(JSONObject().put("iv", enc.iv).put("ciphertext", enc.ciphertext))
        file.writeText(arr.toString())
    }
}
