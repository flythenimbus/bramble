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
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.BeginGetPublicKeyCredentialOption
import androidx.credentials.provider.CallingAppInfo
import androidx.credentials.provider.PendingIntentHandler
import androidx.credentials.provider.ProviderCreateCredentialRequest
import androidx.credentials.provider.ProviderGetCredentialRequest
import androidx.credentials.provider.PublicKeyCredentialEntry
import org.json.JSONObject
import uniffi.vault_crypto.passkeyGetAssertion
import uniffi.vault_crypto.passkeyMakeCredential
import uniffi.vault_crypto.passkeyPrfEval

// Fulfills a Credential Manager passkey GET, launched by BrambleCredentialService via a
// PendingIntent. Two modes after the shared unlock (BrambleUnlockActivity):
//   MODE_GET   - from the provider's AuthenticationAction: list the passkeys matching the
//                request's rpId as entries; the system then renders the picker.
//   MODE_ASSERT- from a picked entry: sign authData||clientDataHash with that passkey's key
//                and return the assertion.
// The vault is read directly (same app); nothing is revealed before unlock. A caller only gets an
// rpId's passkeys when it is entitled to that site (callerMayUse), and the UV flag and PRF answers
// rest on an unlock performed for this ceremony, never a keep-unlocked session. See
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
    private var beginGet: BeginGetCredentialRequest? = null
    private var providerGet: ProviderGetCredentialRequest? = null
    private var providerCreate: ProviderCreateCredentialRequest? = null
    private var needsVerification = false
    private var bridgedVerified = false

    override fun onPrepare() {
        mode = intent.getStringExtra(EXTRA_MODE) ?: MODE_GET
        credentialId = intent.getStringExtra(EXTRA_CREDENTIAL_ID)
        val requests: List<Pair<String, Boolean>> = when (mode) {
            MODE_ASSERT -> {
                providerGet = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent)
                providerGet?.credentialOptions.orEmpty().filterIsInstance<GetPublicKeyCredentialOption>().map { it.requestJson to false }
            }
            MODE_CREATE -> {
                providerCreate = PendingIntentHandler.retrieveProviderCreateCredentialRequest(intent)
                listOfNotNull((providerCreate?.callingRequest as? CreatePublicKeyCredentialRequest)?.requestJson?.let { it to true })
            }
            else -> {
                beginGet = PendingIntentHandler.retrieveBeginGetCredentialRequest(intent)
                beginGet?.beginGetCredentialOptions.orEmpty().filterIsInstance<BeginGetPublicKeyCredentialOption>().map { it.requestJson to false }
            }
        }
        needsVerification = requests.any { (json, create) ->
            runCatching { WebauthnJson.needsVerification(JSONObject(json), create) }.getOrDefault(false)
        }
    }

    override fun requiresFreshUnlock(): Boolean = needsVerification

    // The sign hop reuses the list hop's unlock via the one-shot ceremony handoff, so the user
    // authenticates only once for the whole get() (no double-auth, even with "Immediately" lock).
    override fun bridgeSessionVek(): String? {
        if (mode != MODE_ASSERT) return null
        val ceremony = KeepUnlockedStore.loadCeremony(this) ?: return null
        if (needsVerification && !ceremony.verified) return null
        bridgedVerified = ceremony.verified
        return ceremony.vekB64
    }

    // Whether the user was verified in this ceremony: here, or by the list hop that bridged the VEK.
    private val verified get() = unlockedNow || bridgedVerified

    override fun onVekReady(vekB64: String) {
        // List hop hands its VEK to the sign hop; the sign hop consumes (clears) it.
        when (mode) {
            MODE_GET -> KeepUnlockedStore.saveCeremony(this, vekB64, verified)
            MODE_ASSERT -> KeepUnlockedStore.clearCeremony(this)
        }
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

    // Unlock -> list the passkeys each option allows (its rpId, its allowCredentials) as
    // PublicKeyCredentialEntry items, for a caller entitled to that rpId. The system renders the
    // picker; picking one relaunches this in MODE_ASSERT (assertPendingIntent).
    private fun fillEntryList(resultIntent: Intent): Boolean {
        val request = beginGet ?: return false
        // Only present when the caller asked for it (alwaysSendAppInfoToProvider); the sign hop
        // always has it and enforces callerMayUse again, so this only spares a doomed pick.
        val info = request.callingAppInfo
        val options = request.beginGetCredentialOptions.filterIsInstance<BeginGetPublicKeyCredentialOption>()
        if (options.isEmpty()) return false
        var code = 100 // keep clear of the service's get(1)/create(2) action request codes
        // Vault + not-yet-drained pending passkeys, so a freshly-created one is usable immediately.
        val all = (VaultReader.readPasskeys(this) + VaultReader.readPendingPasskeys(this))
            .distinctBy { it.credentialId }
        val entries = options.flatMap { option ->
            val opts = runCatching { JSONObject(option.requestJson) }.getOrNull() ?: return@flatMap emptyList()
            val rpId = opts.optString("rpId")
            if (rpId.isEmpty() || (info != null && !callerMayUse(info, rpId))) return@flatMap emptyList()
            val allowed = WebauthnJson.allowCredentialIds(opts)
            all.filter { it.rpId == rpId && PasskeyPolicy.allows(allowed, WebauthnJson.stdToUrl(it.credentialId)) }
                .map { pk ->
                    PublicKeyCredentialEntry.Builder(
                        this,
                        pk.userName.ifEmpty { pk.rpId },
                        assertPendingIntent(this, code++, pk.credentialId),
                        option,
                    ).build()
                }
        }
        PendingIntentHandler.setBeginGetCredentialResponse(
            resultIntent,
            BeginGetCredentialResponse(credentialEntries = entries),
        )
        return true
    }

    // Unlock -> sign authData||clientDataHash for the chosen credential and return the assertion.
    private fun fillAssertion(resultIntent: Intent): Boolean {
        val request = providerGet ?: return false
        val option = request.credentialOptions.filterIsInstance<GetPublicKeyCredentialOption>().firstOrNull()
            ?: return false
        val id = credentialId ?: return false
        val pk = (VaultReader.readPasskeys(this) + VaultReader.readPendingPasskeys(this))
            .firstOrNull { it.credentialId == id } ?: return false
        val opts = JSONObject(option.requestJson)
        val challenge = opts.optString("challenge")
        if (challenge.isEmpty()) return false
        // The id rides in our own PendingIntent extra, so check again that this request allows it.
        val allowed = WebauthnJson.allowCredentialIds(opts)
        if (opts.optString("rpId") != pk.rpId || !PasskeyPolicy.allows(allowed, WebauthnJson.stdToUrl(pk.credentialId))) {
            Log.w(TAG, "declined assertion: the picked passkey isn't one this request allows")
            return false
        }
        if (!callerMayUse(request.callingAppInfo, pk.rpId)) return false
        val clientData = clientDataFor(request.callingAppInfo, option.clientDataHash, "webauthn.get", challenge) ?: return false
        val assertion = passkeyGetAssertion(pk.rpId, pk.privateKey, pk.alg, clientData.hashStd, verified)
        // PRF answers only after UV and only with a stored secret; a failure answers without it.
        val prf = pk.prf?.takeIf { verified }?.let { secrets ->
            WebauthnJson.prfSaltsFor(opts, pk.credentialId)?.let { s ->
                runCatching { passkeyPrfEval(secrets.credWithUV, s.firstStd, s.secondStd) }.getOrNull()
            }
        }
        val json = WebauthnJson.authenticationResponseJson(
            pk.credentialId, assertion.authenticatorData, assertion.signature, pk.userHandle, clientData.json,
            prf?.let { WebauthnJson.prfGetResult(it) },
        )
        PendingIntentHandler.setGetCredentialResponse(resultIntent, GetCredentialResponse(PublicKeyCredential(json)))
        return true
    }

    // Unlock -> mint a new ES256 passkey, return its attestation, and stash the credential for the
    // main app to persist into the vault (the sandboxed provider can't write it - PendingPasskey).
    private fun fillCreate(resultIntent: Intent): Boolean {
        val request = providerCreate ?: return false
        val createReq = request.callingRequest as? CreatePublicKeyCredentialRequest ?: return false
        val opts = JSONObject(createReq.requestJson)
        val rpId = opts.optJSONObject("rp")?.optString("id").orEmpty()
        val user = opts.optJSONObject("user")
        val challenge = opts.optString("challenge")
        val caller = request.callingAppInfo.packageName
        if (rpId.isEmpty() || user == null || challenge.isEmpty()) {
            Log.w(TAG, "declined create for $caller: missing rp.id / user / challenge in requestJson")
            return false
        }
        // ES256 (-7) only; decline otherwise so the OS can try another provider. Fail loud: a silent
        // decline surfaces to the RP as "no authenticator supported the algorithms", and on GrapheneOS
        // there is no Google authenticator to fall back to, so this would otherwise be undiagnosable.
        val algs = opts.optJSONArray("pubKeyCredParams")
        val supportsEs256 = algs != null && (0 until algs.length()).any { algs.optJSONObject(it)?.optInt("alg") == -7 }
        if (!supportsEs256) {
            Log.w(TAG, "declined create for $caller: pubKeyCredParams=$algs offers no ES256(-7); Bramble only mints ES256")
            return false
        }
        if (!callerMayUse(request.callingAppInfo, rpId)) return false
        // "none" attestation doesn't sign clientDataJSON, so only its JSON is used here.
        val clientData = clientDataFor(request.callingAppInfo, createReq.clientDataHash, "webauthn.create", challenge)
            ?: return false

        val reg = passkeyMakeCredential(rpId, verified)
        val prfRequest = WebauthnJson.prfRequest(opts)
        val prfOut = prfRequest?.salts?.takeIf { verified }?.let { s ->
            runCatching { passkeyPrfEval(reg.prf.credWithUv, s.firstStd, s.secondStd) }.getOrNull()
        }
        val json = WebauthnJson.registrationResponseJson(
            reg.credentialId, reg.attestationObject, reg.authenticatorData, reg.publicKey, clientData.json,
            prfRequest?.let { WebauthnJson.prfCreateResult(prfOut) },
        )
        // user.id is base64url in the request; we store userHandle as STANDARD base64 like the rest.
        val userHandleStd = user.optString("id").takeIf { it.isNotEmpty() }?.let { WebauthnJson.urlToStd(it) }.orEmpty()
        PendingPasskey.write(this, pendingCredentialJson(reg, rpId, userHandleStd, user.optString("name", "")))
        PendingIntentHandler.setCreateCredentialResponse(resultIntent, CreatePublicKeyCredentialResponse(json))
        return true
    }

    // Whether this caller may use rpId's passkeys: a verified privileged browser whose origin is that
    // site, or an app that rpId's assetlinks.json vouches for. Without it any app could name any site,
    // and while its assertions stay bound to its own apk-key-hash origin, its PRF answers would not.
    // BLOCKING (an assetlinks fetch on a cache miss); the fill* methods run off the main thread.
    private fun callerMayUse(info: CallingAppInfo, rpId: String): Boolean {
        val origin = trustedBrowserOrigin(info)
        if (origin != null) {
            if (PasskeyPolicy.originMayUse(origin, rpId)) return true
            Log.w(TAG, "refused ${info.packageName}: origin $origin may not use $rpId")
            return false
        }
        val fingerprints = signers(info).map { TrustedBrowsers.certFingerprint(it) }.toSet()
        if (DigitalAssetLinks.appMayUseRpId(this, info.packageName, fingerprints, rpId)) return true
        if (TrustedBrowsers.isBrowserApp(this, info.packageName)) warnUnverifiedBrowser(info)
        else Log.w(TAG, "refused ${info.packageName}: $rpId's assetlinks.json doesn't vouch for it")
        return false
    }

    private class ClientData(val json: String, val hashStd: String)

    // A verified privileged browser computes clientDataJSON itself and passes only its hash, which we
    // sign verbatim ("{}" stands in for the JSON). Any other caller's hash is attacker-controllable (a
    // malicious app could hand us one over {origin: https://github.com}), so we ignore it and build
    // clientDataJSON ourselves from the caller's apk-key-hash origin, binding it to the actual caller.
    private fun clientDataFor(info: CallingAppInfo, browserHash: ByteArray?, type: String, challenge: String): ClientData? {
        if (browserHash != null && trustedBrowserOrigin(info) != null) {
            return ClientData("{}", Base64.encodeToString(browserHash, Base64.NO_WRAP))
        }
        val origin = apkKeyHashOrigin(info) ?: return null
        val json = WebauthnJson.clientDataJson(type, challenge, origin)
        return ClientData(json, Base64.encodeToString(WebauthnJson.sha256(json.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP))
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
        put("prf", JSONObject().put("credWithUV", reg.prf.credWithUv).put("credWithoutUV", reg.prf.credWithoutUv))
    }.toString()

    // The caller's web origin IFF it is an allow-listed privileged browser that set the request
    // origin; null for any other caller. getOrigin returns the browser-set origin only when the
    // caller's package + signing cert match the allow-list, and throws when a non-allow-listed
    // caller sets an origin (treated here as untrusted). This gates trusting a caller-supplied
    // clientDataHash. See TrustedBrowsers.
    private fun trustedBrowserOrigin(info: CallingAppInfo): String? =
        try {
            info.getOrigin(TrustedBrowsers.allowlistJson())
        } catch (e: Exception) {
            null
        }

    // A browser app refused for a site: it isn't a verified privileged browser (allow-listed package +
    // cert that set the request origin), so web passkey sign-in can't work in it. Log the signing
    // fingerprints so a missing allow-list entry surfaces as a diagnosable line, not a silent field
    // failure. See docs/sec-audit-7726.md (B2).
    private fun warnUnverifiedBrowser(info: CallingAppInfo) {
        val fingerprints = signers(info).map { TrustedBrowsers.certFingerprint(it) }
        Log.w(
            TAG,
            "browser ${info.packageName} is not a verified privileged browser; web passkey sign-in " +
                "will fail in it. Add it to TrustedBrowsers if these signing fingerprints are legitimate: $fingerprints",
        )
    }

    // The caller's current signing certificates (DER), as the framework verified them.
    private fun signers(info: CallingAppInfo): List<ByteArray> =
        runCatching { info.signingInfo.apkContentsSigners.map { it.toByteArray() } }.getOrDefault(emptyList())

    // clientDataJSON origin for a caller we build the JSON for (anything but a verified privileged
    // browser): the standard android:apk-key-hash:<base64url sha256(signing cert)>, which binds the
    // assertion to the actual caller so a spoofed clientDataHash cannot be reused for another origin.
    private fun apkKeyHashOrigin(info: CallingAppInfo): String? {
        val cert = signers(info).firstOrNull() ?: return null
        return "android:apk-key-hash:" + B64Url.encode(WebauthnJson.sha256(cert))
    }
}
