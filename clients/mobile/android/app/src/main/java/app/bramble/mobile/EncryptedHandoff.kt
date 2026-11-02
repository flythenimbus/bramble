package app.bramble.mobile

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import uniffi.vault_crypto.encryptWithVek

// The provider -> app handoffs (minted passkeys, fill-and-save associations): a JSON array of
// VEK-encrypted records in filesDir, appended by the :autofill provider and drained by the app
// through AutofillBridgePlugin. Every step runs under LockedFile, so an append racing another
// append or a drain is never lost. The Android peer of the iOS App Group handoff.
object EncryptedHandoff {
    /** Encrypt `json` with the loaded VEK and append it. The caller MUST have the VEK loaded. */
    fun append(context: Context, name: String, json: String) {
        val enc = encryptWithVek(json)
        val record = JSONObject().put("iv", enc.iv).put("ciphertext", enc.ciphertext)
        LockedFile.update(file(context, name)) { current -> records(current).put(record).toString() }
    }

    /** Every pending record, cleared in the same locked step. */
    fun take(context: Context, name: String): JSONArray = records(LockedFile.take(file(context, name)))

    /** Put back records the app couldn't decrypt (another vault's), ahead of any appended since. */
    fun restore(context: Context, name: String, keep: JSONArray) {
        if (keep.length() == 0) return
        LockedFile.update(file(context, name)) { current ->
            val merged = JSONArray()
            for (i in 0 until keep.length()) merged.put(keep.get(i))
            val since = records(current)
            for (i in 0 until since.length()) merged.put(since.get(i))
            merged.toString()
        }
    }

    fun file(context: Context, name: String) = File(context.filesDir, name)

    // An unreadable file holds nothing we could decrypt, so it reads as empty.
    private fun records(text: String?): JSONArray =
        text?.let { runCatching { JSONArray(it) }.getOrNull() } ?: JSONArray()
}
