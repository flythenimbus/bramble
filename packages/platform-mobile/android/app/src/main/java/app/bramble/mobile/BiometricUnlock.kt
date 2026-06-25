package app.bramble.mobile

import android.content.Context
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// Reads the biometric-gated VEK that BiometricVaultPlugin.java caches, so the autofill
// provider and the app share one biometric unlock. The Keystore key
// (bramble.biometric.vek) needs a fingerprint/face match to run, enforced by the OS via a
// CryptoObject; the wrapped VEK lives in the same private prefs (biometric_vault). Mirrors
// the plugin's getSecret path. The VEK string returned is loaded into the crypto core by
// the caller (unlockWithVek). See docs/mobile-port.md (Phase 2).
object BiometricUnlock {
    private const val GCM_TAG_BITS = 128
    private const val AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_STRONG

    sealed class Result {
        class Ok(val vekB64: String) : Result()
        object NoSecret : Result()
        object Invalidated : Result()
        object Cancelled : Result()
        class Error(val message: String) : Result()
    }

    /** A cached biometric secret exists and biometrics can authenticate right now. */
    fun isAvailable(context: Context): Boolean {
        val present = hasCachedSecret(context)
        val can = BiometricManager.from(context).canAuthenticate(AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS
        return present && can
    }

    fun hasCachedSecret(context: Context): Boolean {
        val p = context.getSharedPreferences(BrambleAutofill.BIOMETRIC_PREFS, Context.MODE_PRIVATE)
        return p.contains(BrambleAutofill.BIOMETRIC_PREF_CT) && p.contains(BrambleAutofill.BIOMETRIC_PREF_IV)
    }

    /** Prompt for biometrics, then decrypt the cached VEK. Calls back on the main thread. */
    fun unlock(activity: FragmentActivity, title: String, onResult: (Result) -> Unit) {
        val p = activity.getSharedPreferences(BrambleAutofill.BIOMETRIC_PREFS, Context.MODE_PRIVATE)
        val ctB64 = p.getString(BrambleAutofill.BIOMETRIC_PREF_CT, null)
        val ivB64 = p.getString(BrambleAutofill.BIOMETRIC_PREF_IV, null)
        if (ctB64 == null || ivB64 == null) {
            onResult(Result.NoSecret)
            return
        }
        val cipher: Cipher
        try {
            val key = loadKey() ?: run {
                clearSecret(activity)
                onResult(Result.NoSecret)
                return
            }
            cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, Base64.decode(ivB64, Base64.NO_WRAP)))
        } catch (e: KeyPermanentlyInvalidatedException) {
            clearSecret(activity)
            onResult(Result.Invalidated)
            return
        } catch (e: Exception) {
            onResult(Result.Error(e.message ?: "Couldn't prepare biometric unlock"))
            return
        }

        val executor = ContextCompat.getMainExecutor(activity)
        val prompt = BiometricPrompt(activity, executor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                try {
                    val pt = result.cryptoObject!!.cipher!!.doFinal(Base64.decode(ctB64, Base64.NO_WRAP))
                    onResult(Result.Ok(String(pt, Charsets.UTF_8)))
                } catch (e: Exception) {
                    onResult(Result.Error(e.message ?: "Biometric crypto failed"))
                }
            }

            override fun onAuthenticationError(code: Int, message: CharSequence) {
                if (code == BiometricPrompt.ERROR_USER_CANCELED ||
                    code == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                    code == BiometricPrompt.ERROR_CANCELED
                ) {
                    onResult(Result.Cancelled)
                } else {
                    onResult(Result.Error(message.toString()))
                }
            }
        })
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setNegativeButtonText("Use password")
            .setAllowedAuthenticators(AUTHENTICATORS)
            .build()
        prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    private fun loadKey(): SecretKey? {
        val ks = KeyStore.getInstance(BrambleAutofill.BIOMETRIC_KEYSTORE).apply { load(null) }
        return ks.getKey(BrambleAutofill.BIOMETRIC_KEY_ALIAS, null) as? SecretKey
    }

    private fun clearSecret(context: Context) {
        context.getSharedPreferences(BrambleAutofill.BIOMETRIC_PREFS, Context.MODE_PRIVATE)
            .edit().remove(BrambleAutofill.BIOMETRIC_PREF_CT).remove(BrambleAutofill.BIOMETRIC_PREF_IV).apply()
    }
}
