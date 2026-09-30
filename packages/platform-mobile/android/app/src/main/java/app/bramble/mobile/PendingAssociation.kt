package app.bramble.mobile

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import uniffi.vault_crypto.encryptWithVek

// A confirmed "fill and save" handoff, VEK-encrypted; the provider never writes the vault.
// Caller MUST have the VEK loaded.
object PendingAssociation {
    const val FILE = "autofill_pending_assoc.json"

    fun write(context: Context, entryId: String, url: String, vaultId: String) {
        val json = JSONObject()
            .put("entryId", entryId)
            .put("url", url)
            .put("vaultId", vaultId)
            .put("at", System.currentTimeMillis())
        val enc = encryptWithVek(json.toString())
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
