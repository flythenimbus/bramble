package app.bramble.mobile

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Base64
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.BeginGetPublicKeyCredentialOption
import androidx.credentials.provider.CallingAppInfo
import androidx.credentials.provider.PendingIntentHandler
import androidx.credentials.provider.PublicKeyCredentialEntry
import org.json.JSONObject
import uniffi.vault_crypto.passkeyGetAssertion
import uniffi.vault_crypto.passkeyMakeCredential

// Fulfills a Credential Manager passkey GET, launched by BrambleCredentialService via a
// PendingIntent. Two modes after the shared unlock (BrambleUnlockActivity):
//   MODE_GET   - from the provider's AuthenticationAction: list the passkeys matching the
//                request's rpId as entries; the system then renders the picker.
//   MODE_ASSERT- from a picked entry: sign authData||clientDataHash with that passkey's key
//                and return the assertion.
// The vault is read directly (same app); nothing is revealed before unlock. See
// docs/passkey-provider.md.
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class CredentialFulfillActivity : BrambleUnlockActivity() {

    companion object {
        const val EXTRA_MODE = "app.bramble.credential.MODE"
        const val MODE_GET = "get"
        const val MODE_ASSERT = "assert"
        const val MODE_CREATE = "create"
        const val EXTRA_CREDENTIAL_ID = "app.bramble.credential.CREDENTIAL_ID" // STANDARD base64
        private const val TAG = "BrambleCredential"

        // PendingIntent that signs a specific credential (MODE_ASSERT). Mutable so the framework
        // can attach the ProviderGetCredentialRequest extras.
        fun assertPendingIntent(context: Context, requestCode: Int, credentialIdStdB64: String): PendingIntent {
            val intent = Intent(context, CredentialFulfillActivity::class.java)
                .putExtra(EXTRA_MODE, MODE_ASSERT)
                .putExtra(EXTRA_CREDENTIAL_ID, credentialIdStdB64)
            var flags = PendingIntent.FLAG_CANCEL_CURRENT
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
            return PendingIntent.getActivity(context, requestCode, intent, flags)
        }
    }

    private var mode = MODE_GET
    private var credentialId: String? = null

    override fun onPrepare() {
        mode = intent.getStringExtra(EXTRA_MODE) ?: MODE_GET
        credentialId = intent.getStringExtra(EXTRA_CREDENTIAL_ID)
    }

    override fun onVekReady(vekB64: String) {
        Thread {
            val resultIntent = Intent()
            val ok = try {
                when (mode) {
                    MODE_ASSERT -> fillAssertion(resultIntent)
                    MODE_CREATE -> fillCreate(resultIntent)
                    else -> fillEntryList(resultIntent)
                }
            } catch (e: Exception) {
                Log.e(TAG, "credential $mode failed", e)
                false
            }
            runOnUiThread {
                if (!ok) {
                    if (mode == MODE_CREATE) {
                        PendingIntentHandler.setCreateCredentialException(resultIntent, CreateCredentialUnknownException())
                    } else {
                        PendingIntentHandler.setGetCredentialException(resultIntent, GetCredentialUnknownException())
                    }
                }
                setResult(RESULT_OK, resultIntent)
                finishCore()
            }
        }.start()
    }

    override fun onUnlockCancelled() {
        val resultIntent = Intent()
        if (mode == MODE_CREATE) {
            PendingIntentHandler.setCreateCredentialException(resultIntent, CreateCredentialCancellationException())
        } else {
            PendingIntentHandler.setGetCredentialException(resultIntent, GetCredentialCancellationException())
        }
        setResult(RESULT_OK, resultIntent)
    }

    // Unlock -> list the passkeys matching the request's rpId as PublicKeyCredentialEntry items.
    // The system renders the picker; picking one relaunches this in MODE_ASSERT (assertPendingIntent).
    private fun fillEntryList(resultIntent: Intent): Boolean {
        val request = PendingIntentHandler.retrieveBeginGetCredentialRequest(intent) ?: return false
        val options = request.beginGetCredentialOptions.filterIsInstance<BeginGetPublicKeyCredentialOption>()
        if (options.isEmpty()) return false
        val rpIds = options.mapNotNull {
            runCatching { JSONObject(it.requestJson).optString("rpId").ifEmpty { null } }.getOrNull()
        }.toSet()
        val option = options.first()
        var code = 100 // keep clear of the service's get(1)/create(2) action request codes
        val entries = VaultReader.readPasskeys(this)
            .filter { it.rpId in rpIds }
            .map { pk ->
                PublicKeyCredentialEntry.Builder(
                    this,
                    pk.userName.ifEmpty { pk.rpId },
                    assertPendingIntent(this, code++, pk.credentialId),
                    option,
                ).build()
            }
        PendingIntentHandler.setBeginGetCredentialResponse(
            resultIntent,
            BeginGetCredentialResponse(credentialEntries = entries),
        )
        return true
    }

    // Unlock -> sign authData||clientDataHash for the chosen credential and return the assertion.
    private fun fillAssertion(resultIntent: Intent): Boolean {
        val request = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent) ?: return false
        val option = request.credentialOptions.filterIsInstance<GetPublicKeyCredentialOption>().firstOrNull()
            ?: return false
        val id = credentialId ?: return false
        val pk = VaultReader.readPasskeys(this).firstOrNull { it.credentialId == id } ?: return false
        val challenge = JSONObject(option.requestJson).optString("challenge")
        if (challenge.isEmpty()) return false
        // Browser callers (Chrome) compute clientDataJSON themselves and pass only its hash; we
        // MUST sign THAT (the browser substitutes its own clientDataJSON into the response, so ours
        // is a placeholder). Only app callers make us build clientDataJSON, from an apk-key-hash
        // origin. (Signing a self-built clientDataJSON for a browser caller was the bug: its hash
        // didn't match the browser's clientDataJSON, so the RP rejected with NotAllowedError.)
        val browserHash = option.clientDataHash
        val clientDataJson: String
        val clientDataHashStdB64: String
        if (browserHash != null) {
            clientDataJson = "{}"
            clientDataHashStdB64 = Base64.encodeToString(browserHash, Base64.NO_WRAP)
        } else {
            val origin = apkKeyHashOrigin(request.callingAppInfo) ?: return false
            clientDataJson = WebauthnJson.clientDataJson("webauthn.get", challenge, origin)
            clientDataHashStdB64 = Base64.encodeToString(
                WebauthnJson.sha256(clientDataJson.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP,
            )
        }
        // userVerified=true: the unlock just performed (biometric / master password) is a UV.
        val assertion = passkeyGetAssertion(pk.rpId, pk.privateKey, clientDataHashStdB64, true)
        val json = WebauthnJson.authenticationResponseJson(
            pk.credentialId, assertion.authenticatorData, assertion.signature, pk.userHandle, clientDataJson,
        )
        PendingIntentHandler.setGetCredentialResponse(resultIntent, GetCredentialResponse(PublicKeyCredential(json)))
        return true
    }

    // Unlock -> mint a new ES256 passkey, return its attestation, and stash the credential for the
    // main app to persist into the vault (the sandboxed provider can't write it - PendingPasskey).
    private fun fillCreate(resultIntent: Intent): Boolean {
        val request = PendingIntentHandler.retrieveProviderCreateCredentialRequest(intent) ?: return false
        val createReq = request.callingRequest as? CreatePublicKeyCredentialRequest ?: return false
        val opts = JSONObject(createReq.requestJson)
        val rpId = opts.optJSONObject("rp")?.optString("id").orEmpty()
        val user = opts.optJSONObject("user")
        val challenge = opts.optString("challenge")
        if (rpId.isEmpty() || user == null || challenge.isEmpty()) return false
        // ES256 (-7) only; decline otherwise so the OS can try another provider.
        val algs = opts.optJSONArray("pubKeyCredParams")
        val supportsEs256 = algs != null && (0 until algs.length()).any { algs.optJSONObject(it)?.optInt("alg") == -7 }
        if (!supportsEs256) return false

        val reg = passkeyMakeCredential(rpId, true)
        // Same clientDataJSON rule as the assertion: the browser owns it (placeholder here), app
        // callers get an apk-key-hash origin. "none" attestation doesn't sign it regardless.
        val clientDataJson = if (createReq.clientDataHash != null) {
            "{}"
        } else {
            val origin = apkKeyHashOrigin(request.callingAppInfo) ?: return false
            WebauthnJson.clientDataJson("webauthn.create", challenge, origin)
        }
        val json = WebauthnJson.registrationResponseJson(
            reg.credentialId, reg.attestationObject, reg.authenticatorData, reg.publicKey, clientDataJson,
        )
        // user.id is base64url in the request; we store userHandle as STANDARD base64 like the rest.
        val userHandleStd = user.optString("id").takeIf { it.isNotEmpty() }?.let { WebauthnJson.urlToStd(it) }.orEmpty()
        PendingPasskey.write(this, pendingCredentialJson(reg, rpId, userHandleStd, user.optString("name", "")))
        PendingIntentHandler.setCreateCredentialResponse(resultIntent, CreatePublicKeyCredentialResponse(json))
        return true
    }

    // The PasskeyCredential the main app will persist (mirrors core's; base64 stays STANDARD).
    private fun pendingCredentialJson(
        reg: uniffi.vault_crypto.PasskeyRegistration,
        rpId: String,
        userHandleStd: String,
        userName: String,
    ): String = JSONObject().apply {
        put("credentialId", reg.credentialId)
        put("rpId", rpId)
        put("userHandle", userHandleStd)
        put("userName", userName)
        put("alg", -7)
        put("publicKeyCose", reg.publicKeyCose)
        put("privateKey", reg.privateKey)
        put("signCount", 0)
        put("createdAt", System.currentTimeMillis())
    }.toString()

    // clientDataJSON origin for an APP caller (no browser-provided clientDataHash): the standard
    // android:apk-key-hash:<base64url sha256(signing cert)>. Browser callers never reach this
    // (they pass clientDataHash, which we sign directly - no allowlist needed).
    private fun apkKeyHashOrigin(info: CallingAppInfo): String? {
        return try {
            val cert = info.signingInfo.apkContentsSigners.firstOrNull()?.toByteArray() ?: return null
            val sha = WebauthnJson.sha256(cert)
            "android:apk-key-hash:" + Base64.encodeToString(sha, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        } catch (e: Exception) {
            null
        }
    }
}
