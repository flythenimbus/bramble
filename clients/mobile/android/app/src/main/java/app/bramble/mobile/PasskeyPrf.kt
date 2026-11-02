package app.bramble.mobile

import android.os.Build
import androidx.annotation.RequiresApi
import java.util.Base64

// WebAuthn PRF support for the Credential Manager provider. The pure decisions live here, free of
// org.json and android.*, so the host-JVM tests can run them; the JSON lives in WebauthnJson and the
// crypto in the Rust core (passkeyPrfEval). See docs/passkey-prf.md.

/** PRF inputs for one ceremony, STANDARD base64: the site's raw values, never pre-hashed. */
data class PrfSalts(val firstStd: String, val secondStd: String?)

/** A create() that asked for PRF; `salts` is its `eval`, when it sent one. */
class PrfCreate(val salts: PrfSalts?)

/** A passkey's stored PRF secrets (core's PasskeyCredential.prf), STANDARD base64. */
class StoredPrf(val credWithUV: String, val credWithoutUV: String)

/** Unpadded base64url with zero trailing bits: the one spelling every platform decodes alike. */
@RequiresApi(Build.VERSION_CODES.O)
object B64Url {
    /** The canonical spelling of the same bytes (padding and the + / alphabet accepted), or null. */
    fun canonical(s: String): String? =
        try {
            encode(Base64.getUrlDecoder().decode(s.replace('+', '-').replace('/', '_').trimEnd('=')))
        } catch (e: IllegalArgumentException) {
            null
        }

    fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun toStd(canonical: String): String = Base64.getEncoder().encodeToString(Base64.getUrlDecoder().decode(canonical))
}

@RequiresApi(Build.VERSION_CODES.O)
object PasskeyPrf {
    /** One {first, second?} pair as STANDARD base64; null unless each is canonical, as the extension requires. */
    fun salts(first: String, second: String?): PrfSalts? {
        val isCanonical = { s: String -> B64Url.canonical(s) == s }
        if (!isCanonical(first) || (second != null && !isCanonical(second))) return null
        return PrfSalts(B64Url.toStd(first), second?.let { B64Url.toStd(it) })
    }

    /** A credential's own evalByCredential entry (keys are base64url ids, any spelling), else eval. */
    fun select(eval: PrfSalts?, byCredential: Map<String, PrfSalts>, credentialIdUrl: String): PrfSalts? =
        byCredential.entries.firstOrNull { B64Url.canonical(it.key) == credentialIdUrl }?.value ?: eval
}
