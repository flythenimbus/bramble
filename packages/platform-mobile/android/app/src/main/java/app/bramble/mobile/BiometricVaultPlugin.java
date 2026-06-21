package app.bramble.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.Executor;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

// Local Capacitor plugin: caches the vault VEK behind an OS-enforced biometric gate.
// A Keystore AES-256-GCM key created setUserAuthenticationRequired + invalidated-by-
// enrollment wraps the VEK; BiometricPrompt with a CryptoObject is the only way to run
// the cipher, so the OS itself enforces the fingerprint/face check and drops the key if
// the enrolled set changes. The wrapped blob lives in private prefs (safe: undecryptable
// without the gated key). We never run Argon2 here. See docs/mobile-port.md (Phase 2).
@CapacitorPlugin(name = "BiometricVault")
public class BiometricVaultPlugin extends Plugin {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "bramble.biometric.vek";
    private static final String PREFS = "biometric_vault";
    private static final String PREF_CIPHERTEXT = "vek_ct";
    private static final String PREF_IV = "vek_iv";
    private static final int GCM_TAG_BITS = 128;
    private static final int AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_STRONG;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        int result = BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS);
        boolean available = result == BiometricManager.BIOMETRIC_SUCCESS;
        JSObject ret = new JSObject();
        ret.put("available", available);
        ret.put("biometryType", available ? "biometric" : "none");
        call.resolve(ret);
    }

    @PluginMethod
    public void hasSecret(PluginCall call) {
        SharedPreferences prefs = prefs();
        boolean present = prefs.contains(PREF_CIPHERTEXT) && prefs.contains(PREF_IV);
        JSObject ret = new JSObject();
        ret.put("value", present);
        call.resolve(ret);
    }

    @PluginMethod
    public void setSecret(final PluginCall call) {
        final String secret = call.getString("secret");
        if (secret == null) {
            call.reject("Missing secret");
            return;
        }
        try {
            // Fresh key each enable, so the cache binds to the current biometric set.
            deleteKey();
            SecretKey key = generateKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            authenticate(call, cipher, "Enable biometric unlock", new AuthAction() {
                @Override
                public void run(Cipher authed) throws Exception {
                    byte[] ct = authed.doFinal(secret.getBytes(StandardCharsets.UTF_8));
                    SharedPreferences.Editor e = prefs().edit();
                    e.putString(PREF_CIPHERTEXT, Base64.encodeToString(ct, Base64.NO_WRAP));
                    e.putString(PREF_IV, Base64.encodeToString(authed.getIV(), Base64.NO_WRAP));
                    e.apply();
                    call.resolve();
                }
            });
        } catch (Exception e) {
            call.reject("Couldn't store the secret: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getSecret(final PluginCall call) {
        SharedPreferences prefs = prefs();
        String ctB64 = prefs.getString(PREF_CIPHERTEXT, null);
        String ivB64 = prefs.getString(PREF_IV, null);
        if (ctB64 == null || ivB64 == null) {
            call.reject("No biometric secret stored", "no-secret");
            return;
        }
        final byte[] ct = Base64.decode(ctB64, Base64.NO_WRAP);
        byte[] iv = Base64.decode(ivB64, Base64.NO_WRAP);
        try {
            SecretKey key = loadKey();
            if (key == null) {
                clearSecret();
                call.reject("No biometric secret stored", "no-secret");
                return;
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
            authenticate(call, cipher, "Unlock your vault", new AuthAction() {
                @Override
                public void run(Cipher authed) throws Exception {
                    byte[] pt = authed.doFinal(ct);
                    JSObject ret = new JSObject();
                    ret.put("secret", new String(pt, StandardCharsets.UTF_8));
                    call.resolve(ret);
                }
            });
        } catch (KeyPermanentlyInvalidatedException e) {
            // The enrolled biometric set changed; the cache is dead. Drop it so the UI
            // falls back to the password screen and offers re-enabling.
            clearSecret();
            call.reject("Biometric set changed; unlock cache cleared", "invalidated");
        } catch (Exception e) {
            call.reject("Couldn't read the stored secret: " + e.getMessage(), "auth-failed");
        }
    }

    @PluginMethod
    public void deleteSecret(PluginCall call) {
        clearSecret();
        call.resolve();
    }

    // --- helpers ---

    private interface AuthAction {
        void run(Cipher cipher) throws Exception;
    }

    private void authenticate(final PluginCall call, final Cipher cipher, final String title, final AuthAction action) {
        final FragmentActivity activity = getActivity();
        if (activity == null) {
            call.reject("No activity available for the biometric prompt");
            return;
        }
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Executor executor = ContextCompat.getMainExecutor(activity);
                BiometricPrompt prompt = new BiometricPrompt(activity, executor, new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        try {
                            action.run(result.getCryptoObject().getCipher());
                        } catch (Exception e) {
                            call.reject("Biometric crypto failed: " + e.getMessage(), "auth-failed");
                        }
                    }

                    @Override
                    public void onAuthenticationError(int code, CharSequence message) {
                        if (code == BiometricPrompt.ERROR_USER_CANCELED
                                || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                                || code == BiometricPrompt.ERROR_CANCELED) {
                            call.reject("Cancelled", "cancelled");
                        } else {
                            call.reject(message.toString(), "auth-failed");
                        }
                    }
                });
                BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                        .setTitle(title)
                        .setNegativeButtonText("Cancel")
                        .setAllowedAuthenticators(AUTHENTICATORS)
                        .build();
                prompt.authenticate(info, new BiometricPrompt.CryptoObject(cipher));
            }
        });
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private void clearSecret() {
        prefs().edit().remove(PREF_CIPHERTEXT).remove(PREF_IV).apply();
        try {
            deleteKey();
        } catch (Exception ignored) {
        }
    }

    private SecretKey generateKey() throws Exception {
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true)
                .build();
        gen.init(spec);
        return gen.generateKey();
    }

    private SecretKey loadKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        return (SecretKey) ks.getKey(KEY_ALIAS, null);
    }

    private void deleteKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            ks.deleteEntry(KEY_ALIAS);
        }
    }
}
