package app.bramble.mobile

import android.content.Context
import android.net.Uri
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import uniffi.vault_crypto.decryptEntry
import uniffi.vault_crypto.decryptWithVek

// One decrypted login projected for autofill. Mirrors the iOS extension's `Cred` and the
// shared autofill index (autofill-index.ts): only logins with a password reach autofill.
class AutofillLogin(
    val id: String,
    val name: String,
    val username: String,
    val password: String,
    val totp: String?,
    val hostnames: List<String>,
)

// Reads and decrypts the real VLT1 vault the webview manages. The service runs in our own
// package, so there is no iOS-style App Group or pushed bundle: it reads the encrypted
// blob from Filesystem storage and decrypts it with the shared Rust core once the VEK is
// loaded (biometric cache or master password). Nothing here is readable until unlock.
object VaultReader {

    fun vaultFile(context: Context): File =
        File(context.filesDir, BrambleAutofill.VAULT_FILE)

    fun hasVault(context: Context): Boolean = vaultFile(context).exists()

    /** Decode the VLT1 container (slots + encrypted entries blob). No secrets revealed. */
    fun decode(context: Context): VaultBlob = decodeVaultBlob(vaultFile(context).readBytes())

    /**
     * Decrypt every login. The caller MUST have loaded the VEK into the core first
     * (unlockWithVek or unwrapVekPassword). Returns logins in vault order.
     */
    fun readLogins(context: Context): List<AutofillLogin> {
        val blob = decode(context)
        if (blob.entriesCiphertext.isEmpty()) return emptyList()
        val outerJson = decryptWithVek(b64(blob.entriesIv), b64(blob.entriesCiphertext))
        val entries = JSONObject(outerJson).optJSONArray("entries") ?: JSONArray()
        val out = ArrayList<AutofillLogin>(entries.length())
        for (i in 0 until entries.length()) {
            val enc = entries.getJSONObject(i)
            val plaintext = decryptEntry(
                enc.getString("ciphertext"),
                enc.getString("iv"),
                enc.getString("wrappedDek"),
                enc.getString("dekIv"),
            )
            val data = JSONObject(plaintext)
            if (data.optString("type", "login") != "login") continue
            val password = data.optString("password", "")
            if (password.isEmpty()) continue
            out.add(
                AutofillLogin(
                    id = enc.getString("id"),
                    name = data.optString("name", ""),
                    username = data.optString("username", ""),
                    password = password,
                    totp = data.optString("totp", "").ifEmpty { null },
                    hostnames = hostnamesOf(data.optJSONArray("urls")),
                )
            )
        }
        return out
    }

    private fun hostnamesOf(urls: JSONArray?): List<String> {
        if (urls == null) return emptyList()
        val out = ArrayList<String>(urls.length())
        for (i in 0 until urls.length()) {
            val h = extractHostname(urls.optString(i, ""))
            if (h.isNotEmpty()) out.add(h)
        }
        return out
    }

    // entry-normalize derives hostnames as new URL(url).hostname, falling back to the raw
    // string when it doesn't parse (a bare "github.com").
    private fun extractHostname(url: String): String {
        val raw = url.trim()
        if (raw.isEmpty()) return ""
        val host = Uri.parse(if (raw.contains("://")) raw else "https://$raw").host
        return host ?: raw
    }

    // Normalize a service identifier or stored URL to a bare registrable host: prefer the
    // parsed host, else strip scheme/path/query/port by hand, drop "www.", lowercase.
    // Mirrors the iOS extension's normalizeHost.
    fun normalizeHost(raw: String): String {
        var s = raw.trim().lowercase()
        if (s.isEmpty()) return s
        val parsed = Uri.parse(if (s.contains("://")) s else "https://$s").host
        if (parsed != null) {
            s = parsed
        } else {
            s.indexOf("://").let { if (it >= 0) s = s.substring(it + 3) }
            s.indexOf('/').let { if (it >= 0) s = s.substring(0, it) }
            s.indexOf('?').let { if (it >= 0) s = s.substring(0, it) }
            s.indexOf(':').let { if (it >= 0) s = s.substring(0, it) }
        }
        if (s.startsWith("www.")) s = s.substring(4)
        return s
    }

    // A login matches the page if any of its hostnames equals a requested host or is a
    // subdomain either way (login.github.com ~ github.com). Mirrors iOS matchesRequested.
    fun matches(login: AutofillLogin, requestedHosts: List<String>): Boolean {
        if (requestedHosts.isEmpty()) return false
        val services = login.hostnames.map { normalizeHost(it) }.filter { it.isNotEmpty() }
        return services.any { s ->
            requestedHosts.any { w -> s == w || s.endsWith(".$w") || w.endsWith(".$s") }
        }
    }

    private fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)
}
