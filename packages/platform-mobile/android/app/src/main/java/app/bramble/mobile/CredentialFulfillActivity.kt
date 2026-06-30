package app.bramble.mobile

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Base64
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.BeginGetPublicKeyCredentialOption
import androidx.credentials.provider.CallingAppInfo
import androidx.credentials.provider.PendingIntentHandler
import androidx.credentials.provider.PublicKeyCredentialEntry
import org.json.JSONObject
import uniffi.vault_crypto.passkeyGetAssertion

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
                if (mode == MODE_ASSERT) fillAssertion(resultIntent) else fillEntryList(resultIntent)
            } catch (e: Exception) {
                Log.e(TAG, "credential $mode failed", e)
                false
            }
            runOnUiThread {
                if (!ok) {
                    PendingIntentHandler.setGetCredentialException(resultIntent, GetCredentialUnknownException())
                }
                setResult(RESULT_OK, resultIntent)
                finishCore()
            }
        }.start()
    }

    override fun onUnlockCancelled() {
        val resultIntent = Intent()
        PendingIntentHandler.setGetCredentialException(resultIntent, GetCredentialCancellationException())
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
        var code = 1
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
        val origin = originOf(request.callingAppInfo) ?: return false
        val clientDataJson = WebauthnJson.clientDataJson("webauthn.get", challenge, origin)
        val clientDataHashStdB64 = Base64.encodeToString(
            WebauthnJson.sha256(clientDataJson.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP,
        )
        // userVerified=true: the unlock just performed (biometric / master password) is a UV.
        val assertion = passkeyGetAssertion(pk.rpId, pk.privateKey, clientDataHashStdB64, true)
        val json = WebauthnJson.authenticationResponseJson(
            pk.credentialId, assertion.authenticatorData, assertion.signature, pk.userHandle, clientDataJson,
        )
        PendingIntentHandler.setGetCredentialResponse(resultIntent, GetCredentialResponse(PublicKeyCredential(json)))
        return true
    }

    // The web origin bound into clientDataJSON. Browser callers carry the real origin but reading
    // it needs a privileged-browser allowlist (we bundle a local copy to stay Play-free); app
    // callers fall back to an apk-key-hash origin.
    // TODO(passkeys): populate res/raw/privileged_browsers.json with the real browser fingerprints
    // (until then browsers fall to apk-key-hash and the RP rejects the origin) - the Android analog
    // of the iOS clientDataHash work; verify on device. See docs/passkey-provider.md.
    private fun originOf(info: CallingAppInfo): String? {
        val fromBrowser = try {
            val allow = resources.openRawResource(R.raw.privileged_browsers).bufferedReader().use { it.readText() }
            info.getOrigin(allow)
        } catch (e: Exception) {
            Log.w(TAG, "origin: caller not in the privileged-browser allowlist; using apk-key-hash", e)
            null
        }
        return fromBrowser ?: apkKeyHashOrigin(info)
    }

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
