package app.bramble.mobile

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// The Android equivalent of the iOS keep-unlocked Keychain session: a time-limited VEK
// cache so fills within the window skip re-auth. The VEK is wrapped by a hardware-backed
// Keystore key that needs NO biometric (so the window is genuinely re-auth-free) but is
// gated on the device being unlocked, and stored in app-private prefs with a timestamp.
// The window mirrors the app's auto-lock pref via keepUnlockedWindow (GeneralSection.tsx):
// "Immediately" (auto-lock -1) -> 0 = auth every fill; N minutes -> N; "Never" (0) -> never
// expire. The autofill service is short-lived per request, so the cache lives on disk, not
// in process memory. See docs/mobile-port.md.
object KeepUnlockedStore {
    private const val GCM_TAG_BITS = 128

    /** Minutes the cache may live: <=0 means never expire; positive is a real window; null = off. */
    private fun windowMinutes(context: Context): Int? {
        val autoLock = readAutoLockMinutes(context)
        // keepUnlockedWindow: Immediately(-1)->0 off; N>0 -> N; Never(0) -> -1 never expire.
        val window = if (autoLock < 0) 0 else if (autoLock > 0) autoLock else -1
        return if (window == 0) null else window
    }

    private fun readAutoLockMinutes(context: Context): Int {
        val prefs = context.getSharedPreferences(BrambleAutofill.CAPACITOR_PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(BrambleAutofill.PREF_AUTOLOCK_MINUTES, null)
        return raw?.trim()?.toIntOrNull() ?: BrambleAutofill.DEFAULT_AUTOLOCK_MINUTES
    }

    /** Cache the VEK and stamp the window start. No-op when keep-unlocked is off. */
    fun save(context: Context, vekB64: String) {
        if (windowMinutes(context) == null) return
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, sessionKey())
            val ct = cipher.doFinal(vekB64.toByteArray(Charsets.UTF_8))
            prefs(context).edit()
                .putString(BrambleAutofill.SESSION_PREF_CT, Base64.encodeToString(ct, Base64.NO_WRAP))
                .putString(BrambleAutofill.SESSION_PREF_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .putLong(BrambleAutofill.SESSION_PREF_AT, System.currentTimeMillis())
                .apply()
        } catch (e: Exception) {
            clear(context)
        }
    }

    /** The cached VEK, or null when off, absent, or the window has elapsed. */
    fun load(context: Context): String? {
        val window = windowMinutes(context) ?: return null // off
        val p = prefs(context)
        val ctB64 = p.getString(BrambleAutofill.SESSION_PREF_CT, null) ?: return null
        val ivB64 = p.getString(BrambleAutofill.SESSION_PREF_IV, null) ?: return null
        val at = p.getLong(BrambleAutofill.SESSION_PREF_AT, 0L)
        if (window > 0 && System.currentTimeMillis() - at > window * 60_000L) {
            clear(context)
            return null
        }
        return try {
            val key = loadSessionKey() ?: return null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, Base64.decode(ivB64, Base64.NO_WRAP)))
            String(cipher.doFinal(Base64.decode(ctB64, Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (e: Exception) {
            clear(context)
            null
        }
    }

    fun clear(context: Context) {
        prefs(context).edit()
            .remove(BrambleAutofill.SESSION_PREF_CT)
            .remove(BrambleAutofill.SESSION_PREF_IV)
            .remove(BrambleAutofill.SESSION_PREF_AT)
            .apply()
    }

    // --- one-shot credential-ceremony VEK handoff (MODE_GET unlock -> MODE_ASSERT sign) ---
    // The Credential Manager passkey GET is two activities: the first unlocks to LIST passkeys,
    // the second unlocks to SIGN the picked one. To avoid asking twice, the first hands the VEK to
    // the second through this short-lived, Keystore-wrapped slot - INDEPENDENT of the keep-unlocked
    // window, so it bridges even with "Immediately" auto-lock - cleared once the sign hop consumes
    // it. Same hardware key + unlocked-device gating as the session above; just a tight fixed TTL.
    private const val CEREMONY_CT = "ceremony.ct"
    private const val CEREMONY_IV = "ceremony.iv"
    private const val CEREMONY_AT = "ceremony.at"
    private const val CEREMONY_TTL_MS = 120_000L

    fun saveCeremony(context: Context, vekB64: String) {
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, sessionKey())
            val ct = cipher.doFinal(vekB64.toByteArray(Charsets.UTF_8))
            prefs(context).edit()
                .putString(CEREMONY_CT, Base64.encodeToString(ct, Base64.NO_WRAP))
                .putString(CEREMONY_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .putLong(CEREMONY_AT, System.currentTimeMillis())
                .apply()
        } catch (e: Exception) {
            clearCeremony(context)
        }
    }

    fun loadCeremony(context: Context): String? {
        val p = prefs(context)
        val ctB64 = p.getString(CEREMONY_CT, null) ?: return null
        val ivB64 = p.getString(CEREMONY_IV, null) ?: return null
        if (System.currentTimeMillis() - p.getLong(CEREMONY_AT, 0L) > CEREMONY_TTL_MS) {
            clearCeremony(context)
            return null
        }
        return try {
            val key = loadSessionKey() ?: return null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, Base64.decode(ivB64, Base64.NO_WRAP)))
            String(cipher.doFinal(Base64.decode(ctB64, Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (e: Exception) {
            clearCeremony(context)
            null
        }
    }

    fun clearCeremony(context: Context) {
        prefs(context).edit().remove(CEREMONY_CT).remove(CEREMONY_IV).remove(CEREMONY_AT).apply()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(BrambleAutofill.SESSION_PREFS, Context.MODE_PRIVATE)

    private fun sessionKey(): SecretKey = loadSessionKey() ?: generateSessionKey()

    private fun loadSessionKey(): SecretKey? {
        val ks = KeyStore.getInstance(BrambleAutofill.BIOMETRIC_KEYSTORE).apply { load(null) }
        return ks.getKey(BrambleAutofill.SESSION_KEY_ALIAS, null) as? SecretKey
    }

    private fun generateSessionKey(): SecretKey {
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, BrambleAutofill.BIOMETRIC_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            BrambleAutofill.SESSION_KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .apply {
                // Bind the cache to the device being unlocked, like the iOS item's
                // WhenUnlockedThisDeviceOnly. No biometric required: the window IS re-auth-free.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setUnlockedDeviceRequired(true)
            }
            .build()
        gen.init(spec)
        return gen.generateKey()
    }
}
