package app.bramble.mobile

// WebAuthn PRF support for the Credential Manager provider. The pure decisions live here, free of
// org.json and android.*, so the host-JVM tests can run them; the JSON lives in WebauthnJson and the
// crypto in the Rust core (passkeyPrfEval). See docs/passkey-prf.md.

/** PRF inputs for one ceremony, STANDARD base64: the site's raw values, never pre-hashed. */
data class PrfSalts(val firstStd: String, val secondStd: String?)

/** A create() that asked for PRF; `salts` is its `eval`, when it sent one. */
class PrfCreate(val salts: PrfSalts?)

/** A passkey's stored PRF secrets (core's PasskeyCredential.prf), STANDARD base64. */
class StoredPrf(val credWithUV: String, val credWithoutUV: String)

object PasskeyPrf {
    /** A credential's own evalByCredential entry (keys are base64url credential ids), else eval. */
    fun select(eval: PrfSalts?, byCredential: Map<String, PrfSalts>, credentialIdUrl: String): PrfSalts? =
        byCredential[credentialIdUrl] ?: eval
}
