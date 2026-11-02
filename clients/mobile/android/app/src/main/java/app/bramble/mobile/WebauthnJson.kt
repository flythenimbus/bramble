package app.bramble.mobile

import android.os.Build
import android.util.Base64
import androidx.annotation.RequiresApi
import org.json.JSONArray
import org.json.JSONObject
import uniffi.vault_crypto.PasskeyPrfOutput
import java.security.MessageDigest

// Builds the W3C WebAuthn response JSON the Android Credential Manager expects from a passkey
// provider - the same shape the Chromium extension produces in webauthn-json.ts. The Rust core
// emits STANDARD base64; WebAuthn JSON uses base64url, so fields are converted here. Used only
// by the credential provider (API 34+). See docs/passkey-provider.md.
@RequiresApi(Build.VERSION_CODES.O)
object WebauthnJson {

    private const val URL_FLAGS = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP

    /** STANDARD base64 (Rust/stored) -> base64url no-pad, via the raw bytes. */
    fun stdToUrl(stdB64: String): String =
        Base64.encodeToString(Base64.decode(stdB64, Base64.DEFAULT), URL_FLAGS)

    /** base64url (request JSON, e.g. user.id) -> STANDARD base64, the form we store. */
    fun urlToStd(urlB64: String): String =
        Base64.encodeToString(Base64.decode(urlB64, Base64.URL_SAFE), Base64.NO_WRAP)

    private fun bytesToUrl(bytes: ByteArray): String = Base64.encodeToString(bytes, URL_FLAGS)

    fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    // ---- PRF (page-supplied, so anything malformed is treated as absent; docs/passkey-prf.md) ----

    private fun prfJson(opts: JSONObject): JSONObject? =
        opts.optJSONObject("extensions")?.optJSONObject("prf")

    // One base64url {first, second?} pair as STANDARD base64; null when malformed.
    private fun salts(v: JSONObject?): PrfSalts? {
        val first = v?.opt("first") as? String ?: return null
        val second = v.opt("second")
        if (second != null && second !is String) return null
        return PasskeyPrf.salts(first, second as String?)
    }

    /** create(): null when the site didn't ask for PRF. */
    fun prfRequest(opts: JSONObject): PrfCreate? =
        prfJson(opts)?.let { PrfCreate(salts(it.optJSONObject("eval"))) }

    /** get(): the inputs for this credential (STANDARD base64 id), or null when none apply. */
    fun prfSaltsFor(opts: JSONObject, credentialIdStd: String): PrfSalts? {
        val prf = prfJson(opts) ?: return null
        val byCredential = HashMap<String, PrfSalts>()
        prf.optJSONObject("evalByCredential")?.let { map ->
            for (key in map.keys()) salts(map.optJSONObject(key))?.let { byCredential[key] = it }
        }
        return PasskeyPrf.select(salts(prf.optJSONObject("eval")), byCredential, stdToUrl(credentialIdStd))
    }

    /** Whether a get() (or a create(), whose preference sits in authenticatorSelection) needs a fresh unlock. */
    fun needsVerification(opts: JSONObject, create: Boolean): Boolean {
        val holder = if (create) opts.optJSONObject("authenticatorSelection") else opts
        return PasskeyPolicy.needsVerification(holder?.optString("userVerification"), prfJson(opts) != null)
    }

    /** A get()'s allowCredentials ids (base64url); null when it names none, which allows any. */
    fun allowCredentialIds(opts: JSONObject): List<String>? {
        val list = opts.optJSONArray("allowCredentials")?.takeIf { it.length() > 0 } ?: return null
        return (0 until list.length()).mapNotNull { list.optJSONObject(it)?.opt("id") as? String }
    }

    /** clientExtensionResults.prf for a create: enabled, with results when evaluated. */
    fun prfCreateResult(out: PasskeyPrfOutput?): JSONObject = JSONObject().apply {
        put("enabled", true)
        if (out != null) put("results", prfResults(out))
    }

    /** clientExtensionResults.prf for a get. */
    fun prfGetResult(out: PasskeyPrfOutput): JSONObject = JSONObject().put("results", prfResults(out))

    private fun prfResults(out: PasskeyPrfOutput): JSONObject = JSONObject().apply {
        put("first", stdToUrl(out.first))
        out.second?.let { put("second", stdToUrl(it)) }
    }

    private fun extensionResults(prf: JSONObject?): JSONObject =
        if (prf != null) JSONObject().put("prf", prf) else JSONObject()

    /**
     * Canonical clientDataJSON for a ceremony. `challengeB64Url` is the RP's challenge verbatim
     * (already base64url, straight out of the request JSON). The provider builds this so its hash
     * matches what it signs; the RP recomputes the hash from this exact string.
     */
    fun clientDataJson(type: String, challengeB64Url: String, origin: String): String =
        JSONObject().apply {
            put("type", type)
            put("challenge", challengeB64Url)
            put("origin", origin)
            put("crossOrigin", false)
        }.toString()

    /**
     * AuthenticationResponseJSON for an assertion. credentialId/authenticatorData/signature/
     * userHandle are STANDARD base64 (converted to b64url here); `clientDataJson` is the raw JSON
     * string (base64url-encoded into the response). Wrap in PublicKeyCredential(...) for the
     * GetCredentialResponse.
     */
    fun authenticationResponseJson(
        credentialIdStdB64: String,
        authenticatorDataStdB64: String,
        signatureStdB64: String,
        userHandleStdB64: String?,
        clientDataJson: String,
        prf: JSONObject? = null,
    ): String {
        val id = stdToUrl(credentialIdStdB64)
        val response = JSONObject().apply {
            put("clientDataJSON", bytesToUrl(clientDataJson.toByteArray(Charsets.UTF_8)))
            put("authenticatorData", stdToUrl(authenticatorDataStdB64))
            put("signature", stdToUrl(signatureStdB64))
            put(
                "userHandle",
                userHandleStdB64?.takeIf { it.isNotEmpty() }?.let { stdToUrl(it) } ?: JSONObject.NULL,
            )
        }
        return JSONObject().apply {
            put("id", id)
            put("rawId", id)
            put("type", "public-key")
            put("authenticatorAttachment", "platform")
            put("response", response)
            put("clientExtensionResults", extensionResults(prf))
        }.toString()
    }

    /**
     * RegistrationResponseJSON for a create(). credentialId/attestationObject/authenticatorData/
     * publicKey are STANDARD base64 (converted to b64url); publicKey is the SPKI DER. Includes the
     * full field set (publicKey + publicKeyAlgorithm + authenticatorData) that strict RPs / Chrome
     * require, matching the extension. Wrap in CreatePublicKeyCredentialResponse(...).
     */
    fun registrationResponseJson(
        credentialIdStdB64: String,
        attestationObjectStdB64: String,
        authenticatorDataStdB64: String,
        publicKeyStdB64: String,
        clientDataJson: String,
        prf: JSONObject? = null,
    ): String {
        val id = stdToUrl(credentialIdStdB64)
        val response = JSONObject().apply {
            put("clientDataJSON", bytesToUrl(clientDataJson.toByteArray(Charsets.UTF_8)))
            put("attestationObject", stdToUrl(attestationObjectStdB64))
            put("authenticatorData", stdToUrl(authenticatorDataStdB64))
            put("publicKeyAlgorithm", -7)
            put("publicKey", stdToUrl(publicKeyStdB64))
            put("transports", JSONArray(listOf("internal", "hybrid")))
        }
        return JSONObject().apply {
            put("id", id)
            put("rawId", id)
            put("type", "public-key")
            put("authenticatorAttachment", "platform")
            put("response", response)
            put("clientExtensionResults", extensionResults(prf))
        }.toString()
    }
}
