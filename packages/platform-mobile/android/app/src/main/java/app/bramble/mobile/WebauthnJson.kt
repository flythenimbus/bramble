package app.bramble.mobile

import android.util.Base64
import org.json.JSONObject
import java.security.MessageDigest

// Builds the W3C WebAuthn response JSON the Android Credential Manager expects from a passkey
// provider - the same shape the Chromium extension produces in webauthn-json.ts. The Rust core
// emits STANDARD base64; WebAuthn JSON uses base64url, so fields are converted here. Used only
// by the credential provider (API 34+). See docs/passkey-provider.md.
object WebauthnJson {

    private const val URL_FLAGS = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP

    /** STANDARD base64 (Rust/stored) -> base64url no-pad, via the raw bytes. */
    fun stdToUrl(stdB64: String): String =
        Base64.encodeToString(Base64.decode(stdB64, Base64.DEFAULT), URL_FLAGS)

    private fun bytesToUrl(bytes: ByteArray): String = Base64.encodeToString(bytes, URL_FLAGS)

    fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

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
            put("clientExtensionResults", JSONObject())
        }.toString()
    }
}
