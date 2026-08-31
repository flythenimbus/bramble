package app.bramble.mobile

import android.content.Context
import android.net.Uri
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
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

// One stored passkey (provider role) extracted from a login entry's `passkeys[]`. All base64
// fields are STANDARD base64 (as stored): credentialId/userHandle/privateKey. privateKey is the
// only secret; the Rust core signs with it. Mirrors core's PasskeyCredential.
class StoredPasskey(
    val entryId: String,
    val credentialId: String,
    val rpId: String,
    val userName: String,
    val userHandle: String,
    val privateKey: String,
    /** COSE algorithm. Defaulted to ES256 for records written before imports could be EdDSA. */
    val alg: Int,
)

// Reads and decrypts the real VLT1 vault the webview manages. The service runs in our own
// package, so there is no iOS-style App Group or pushed bundle: it reads the encrypted
// blob from Filesystem storage and decrypts it with the shared Rust core once the VEK is
// loaded (biometric cache or master password). Nothing here is readable until unlock.
object VaultReader {

    /**
     * The blob file to fill from: the active vault's namespaced file `vault-<id>.vlt1`, falling back
     * to the pre-namespacing fixed `vault.vlt1` (the app runs the one-time migration on its next
     * launch, but the service can fire before that). Null when nothing is stored yet. Single-active:
     * the service fills whichever vault the app is in (activeVaultId), mirroring readVaultBlob.
     */
    fun vaultFile(context: Context): File? {
        activeVaultId(context)?.let { id ->
            val f = File(context.filesDir, blobFileName(id))
            if (f.exists()) return f
        }
        val flat = File(context.filesDir, BrambleAutofill.VAULT_FILE)
        return if (flat.exists()) flat else null
    }

    private fun blobFileName(id: String): String = "vault-$id.vlt1"

    /**
     * The vault the app is currently in (single-active), read from the same Capacitor prefs the
     * webview writes: `meta:active-vault` (a JSON string) else the first registered vault. Mirrors
     * sync-manager's activeVaultId. Null on a pre-migration install (no registry yet), so callers
     * fall back to the fixed blob path.
     */
    fun activeVaultId(context: Context): String? {
        val prefs = context.getSharedPreferences(BrambleAutofill.CAPACITOR_PREFS, Context.MODE_PRIVATE)
        prefs.getString(BrambleAutofill.PREF_ACTIVE_VAULT, null)?.let { raw ->
            val v = try { JSONTokener(raw).nextValue() } catch (e: Exception) { null }
            if (v is String && v.isNotEmpty()) return v
        }
        val regRaw = prefs.getString(BrambleAutofill.PREF_VAULT_REGISTRY, null) ?: return null
        return try {
            JSONObject(regRaw).optJSONArray("vaults")?.optJSONObject(0)?.optString("id", "")
                ?.ifEmpty { null }
        } catch (e: Exception) {
            null
        }
    }

    fun hasVault(context: Context): Boolean = vaultFile(context) != null

    /** Decode the VLT1 container (slots + encrypted entries blob). No secrets revealed. */
    fun decode(context: Context): VaultBlob {
        val f = vaultFile(context) ?: throw IllegalStateException("no vault stored")
        return decodeVaultBlob(f.readBytes())
    }

    /**
     * Decrypt every live login. The caller MUST have loaded the VEK into the core first
     * (unlockWithVek or unwrapVekPassword). Returns logins in vault order.
     *
     * Archived entries (`archivedAt` present) are skipped. This service reads the vault
     * file itself rather than the index core builds, so it repeats the rule that
     * `core/vault/autofill-index.ts` applies for every other surface.
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
            if (isArchived(data)) continue
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

    /**
     * Decrypt every login's passkeys (provider role). The caller MUST have loaded the VEK
     * first, exactly like readLogins. Reads the `passkeys[]` array off each login entry; all
     * base64 fields stay STANDARD base64 (as stored) - WebauthnJson converts to b64url and the
     * Rust core consumes them verbatim. Returns every stored passkey on a live login (those on
     * an archived one are skipped, as in readLogins); callers filter by rpId.
     */
    fun readPasskeys(context: Context): List<StoredPasskey> {
        val blob = decode(context)
        if (blob.entriesCiphertext.isEmpty()) return emptyList()
        val outerJson = decryptWithVek(b64(blob.entriesIv), b64(blob.entriesCiphertext))
        val entries = JSONObject(outerJson).optJSONArray("entries") ?: JSONArray()
        val out = ArrayList<StoredPasskey>()
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
            if (isArchived(data)) continue
            val passkeys = data.optJSONArray("passkeys") ?: continue
            val entryId = enc.getString("id")
            for (j in 0 until passkeys.length()) {
                val pk = passkeys.optJSONObject(j) ?: continue
                val credentialId = pk.optString("credentialId", "")
                val rpId = pk.optString("rpId", "")
                val privateKey = pk.optString("privateKey", "")
                if (credentialId.isEmpty() || rpId.isEmpty() || privateKey.isEmpty()) continue
                out.add(
                    StoredPasskey(
                        entryId = entryId,
                        credentialId = credentialId,
                        rpId = rpId,
                        userName = pk.optString("userName", ""),
                        userHandle = pk.optString("userHandle", ""),
                        privateKey = privateKey,
                        alg = pk.optInt("alg", -7),
                    )
                )
            }
        }
        return out
    }

    /**
     * Passkeys the credential provider just minted but the main app hasn't drained into the vault
     * yet (PendingPasskey file). Lets a freshly-created passkey be used immediately, before the
     * app reconciles it - the Android analog of the iOS create-time bridge. VEK must be loaded.
     * Callers merge with readPasskeys (dedup by credentialId).
     */
    fun readPendingPasskeys(context: Context): List<StoredPasskey> {
        val file = File(context.filesDir, PendingPasskey.FILE)
        if (!file.exists()) return emptyList()
        val arr = try { JSONArray(file.readText()) } catch (e: Exception) { return emptyList() }
        val out = ArrayList<StoredPasskey>(arr.length())
        for (i in 0 until arr.length()) {
            val e = arr.optJSONObject(i) ?: continue
            val iv = e.optString("iv")
            val ct = e.optString("ciphertext")
            if (iv.isEmpty() || ct.isEmpty()) continue
            try {
                val pk = JSONObject(decryptWithVek(iv, ct))
                val credentialId = pk.optString("credentialId", "")
                val rpId = pk.optString("rpId", "")
                val privateKey = pk.optString("privateKey", "")
                if (credentialId.isEmpty() || rpId.isEmpty() || privateKey.isEmpty()) continue
                out.add(
                    StoredPasskey(
                        entryId = "",
                        credentialId = credentialId,
                        rpId = rpId,
                        userName = pk.optString("userName", ""),
                        userHandle = pk.optString("userHandle", ""),
                        privateKey = privateKey,
                        alg = pk.optInt("alg", -7),
                    )
                )
            } catch (e: Exception) {
                // Skip an entry we can't decrypt/parse.
            }
        }
        return out
    }

    /** An entry the user has archived: present and non-zero `archivedAt`, absent means live. */
    private fun isArchived(data: JSONObject): Boolean = data.optLong("archivedAt", 0L) > 0L

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
