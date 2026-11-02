package app.bramble.mobile

import android.os.Build
import androidx.annotation.RequiresApi
import java.net.URI

// Which passkeys the Credential Manager provider offers a caller, and when it must verify the user
// afresh. Pure (no org.json, no android.*) so the host-JVM tests run it. See docs/passkey-provider.md.
@RequiresApi(Build.VERSION_CODES.O)
object PasskeyPolicy {
    /** allowCredentials: null allows any credential; ids compare by canonical spelling. */
    fun allows(allowIds: List<String>?, credentialIdUrl: String): Boolean =
        allowIds == null || allowIds.any { B64Url.canonical(it) == credentialIdUrl }

    /** A browser origin may use rpId when it is that site or a subdomain, over https (http only for localhost). */
    fun originMayUse(origin: String, rpId: String): Boolean {
        val uri = runCatching { URI(origin) }.getOrNull() ?: return false
        val host = uri.host?.lowercase() ?: return false
        val id = rpId.lowercase()
        val secure = uri.scheme == "https" || (uri.scheme == "http" && host == "localhost")
        return secure && id.isNotEmpty() && (host == id || host.endsWith(".$id"))
    }

    /** A keep-unlocked session isn't a user verification: UV "required" and PRF need a fresh unlock. */
    fun needsVerification(userVerification: String?, wantsPrf: Boolean): Boolean =
        userVerification == "required" || wantsPrf
}
