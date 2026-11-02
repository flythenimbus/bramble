package app.bramble.mobile

import android.content.Context
import org.json.JSONObject

// A confirmed "fill and save" handoff, VEK-encrypted; the provider never writes the vault.
// Caller MUST have the VEK loaded. See EncryptedHandoff.
object PendingAssociation {
    const val FILE = "autofill_pending_assoc.json"

    fun write(context: Context, entryId: String, url: String, vaultId: String, label: String) {
        val json = JSONObject()
            .put("entryId", entryId)
            .put("url", url)
            .put("label", label)
            .put("vaultId", vaultId)
        EncryptedHandoff.append(context, FILE, json.toString())
    }
}
