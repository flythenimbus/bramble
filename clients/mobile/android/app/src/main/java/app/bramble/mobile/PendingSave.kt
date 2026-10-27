package app.bramble.mobile

import android.content.Context
import org.json.JSONObject
import java.io.File

// A captured sign-in waiting to be saved into the vault. The autofill service can't write
// the encrypted vault itself without re-implementing the entry/blob crypto (and risking
// corruption or sync drift), so it hands the credential to the main app, which saves it
// through its proven, audited entry-creation path. The handoff is a small app-private file
// in the same Filesystem dir the webview reads (Directory.Data); the app consumes and
// deletes it on next launch, opening the add-login form prefilled. See docs/mobile-port.md.
object PendingSave {
    private const val FILE = "autofill_pending_save.json"

    fun write(context: Context, host: String, username: String, password: String) {
        val json = JSONObject()
            .put("host", host)
            .put("username", username)
            .put("password", password)
            .put("at", System.currentTimeMillis())
        File(context.filesDir, FILE).writeText(json.toString())
    }
}
