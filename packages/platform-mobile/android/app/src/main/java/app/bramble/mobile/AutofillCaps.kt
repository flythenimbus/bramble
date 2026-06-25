package app.bramble.mobile

import android.content.Context
import org.json.JSONObject
import java.io.File

// Records device autofill capabilities the app can't otherwise probe, so Settings can hide
// controls that wouldn't work here. Inline-suggestion support (iOS-QuickType equivalent) is
// only revealed to the service during a fill request (request.inlineSuggestionsRequest) and
// depends on the active keyboard: Gboard / SwiftKey support it, the AOSP keyboard does not.
// Stored as a file (not SharedPreferences) so the main app process reads a fresh value across
// the :autofill process boundary without the multi-process SharedPreferences cache hazard.
object AutofillCaps {
    private const val FILE = "autofill_caps.json"

    fun recordInlineSupport(context: Context, supported: Boolean) {
        val f = File(context.filesDir, FILE)
        val current = runCatching { JSONObject(f.readText()).optBoolean("inlineSupported") }.getOrNull()
        if (current == supported) return
        runCatching { f.writeText(JSONObject().put("inlineSupported", supported).toString()) }
    }
}
