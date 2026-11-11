package app.bramble.mobile

import android.app.Activity
import android.content.Intent
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

// Copies a file the app wrote (a decrypted attachment in cache) to a place the user picks in the
// system save dialog. Android's share sheet has no reliable "save to device" target (#217).
@CapacitorPlugin(name = "FileSaver")
class FileSaverPlugin : Plugin() {

    @PluginMethod
    fun saveAs(call: PluginCall) {
        val src = call.getString("srcPath")
        if (src == null || !File(src).isFile) {
            call.reject("No file to save")
            return
        }
        val mime = call.getString("mime")?.takeIf { it.isNotBlank() } ?: "application/octet-stream"
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime)
            .putExtra(Intent.EXTRA_TITLE, call.getString("name") ?: "attachment")
        startActivityForResult(call, intent, "onPicked")
    }

    @ActivityCallback
    private fun onPicked(call: PluginCall, result: ActivityResult) {
        val uri = result.data?.data
        val src = call.getString("srcPath")
        if (result.resultCode != Activity.RESULT_OK || uri == null || src == null) {
            call.resolve(JSObject().put("saved", false))
            return
        }
        // Off the main thread: an attachment can be hundreds of MB.
        Thread {
            try {
                val out = context.contentResolver.openOutputStream(uri, "w")
                    ?: throw IllegalStateException("Couldn't write to that location")
                out.use { File(src).inputStream().use { input -> input.copyTo(out) } }
                call.resolve(JSObject().put("saved", true))
            } catch (e: Throwable) {
                // A half-written file would look like a good copy.
                runCatching { DocumentsContract.deleteDocument(context.contentResolver, uri) }
                call.reject(e.message ?: e.toString())
            }
        }.start()
    }
}
