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
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.concurrent.Executor;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

// Local Capacitor plugin: caches each vault's VEK behind an OS-enforced biometric gate.
// A Keystore AES-256-GCM key created setUserAuthenticationRequired + invalidated-by-
// enrollment wraps the VEK; BiometricPrompt with a CryptoObject is the only way to run
// the cipher, so the OS itself enforces the fingerprint/face check and drops the key if
// the enrolled set changes. The wrapped blob lives in private prefs (safe: undecryptable
// without the gated key). Each vault gets its own alias + prefs (suffixed :<vaultId>) so
// enabling biometric on one vault never overwrites another's cached VEK; the autofill
// service (BiometricUnlock.kt) reads the same per-vault keys for the active vault. We never
// run Argon2 here. See docs/mobile-port.md (Phase 2).
@CapacitorPlugin(name = "BiometricVault")
public class BiometricVaultPlugin extends Plugin {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "bramble.biometric.vek";
    private static final String PREFS = "biometric_vault";
    private static final String PREF_CIPHERTEXT = "vek_ct";
    private static final String PREF_IV = "vek_iv";
    private static final int GCM_TAG_BITS = 128;
    private static final int AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_STRONG;

    private static String aliasFor(String vaultId) { return KEY_ALIAS + ":" + vaultId; }
    private static String ctKey(String vaultId) { return PREF_CIPHERTEXT + ":" + vaultId; }
    private static String ivKey(String vaultId) { return PREF_IV + ":" + vaultId; }

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
        String vaultId = call.getString("vaultId");
        if (vaultId == null) {
            call.reject("Missing vaultId");
            return;
        }
        SharedPreferences prefs = prefs();
        boolean present = prefs.contains(ctKey(vaultId)) && prefs.contains(ivKey(vaultId));
        JSObject ret = new JSObject();
        ret.put("value", present);
        call.resolve(ret);
    }

    @PluginMethod
    public void setSecret(final PluginCall call) {
        final String vaultId = call.getString("vaultId");
        if (vaultId == null) {
            call.reject("Missing vaultId");
            return;
        }
        final String secret = call.getString("secret");
        if (secret == null) {
            call.reject("Missing secret");
            return;
        }
        try {
            // Drop the stored ciphertext BEFORE the key it belongs to. The prompt below can be
            // cancelled or fail, and it is the only thing that writes the replacement: leaving the
            // old ciphertext next to a key that no longer exists reads as "enabled" to hasSecret
            // and then fails every unlock with a null-message AEAD error. Nothing is worse to lose
            // here than the cache itself, which the master password rebuilds.
            clearSecret(vaultId);
            // Fresh key each enable, so this vault's cache binds to the current biometric set.
            deleteKey(aliasFor(vaultId));
            SecretKey key = generateKey(aliasFor(vaultId));
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            authenticate(call, cipher, "Enable biometric unlock", new AuthAction() {
                @Override
                public void run(Cipher authed) throws Exception {
                    byte[] ct = authed.doFinal(secret.getBytes(StandardCharsets.UTF_8));
                    SharedPreferences.Editor e = prefs().edit();
                    e.putString(ctKey(vaultId), Base64.encodeToString(ct, Base64.NO_WRAP));
                    e.putString(ivKey(vaultId), Base64.encodeToString(authed.getIV(), Base64.NO_WRAP));
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
        final String vaultId = call.getString("vaultId");
        if (vaultId == null) {
            call.reject("Missing vaultId");
            return;
        }
        SharedPreferences prefs = prefs();
        String ctB64 = prefs.getString(ctKey(vaultId), null);
        String ivB64 = prefs.getString(ivKey(vaultId), null);
        if (ctB64 == null || ivB64 == null) {
            call.reject("No biometric secret stored", "no-secret");
            return;
        }
        final byte[] ct = Base64.decode(ctB64, Base64.NO_WRAP);
        byte[] iv = Base64.decode(ivB64, Base64.NO_WRAP);
        try {
            SecretKey key = loadKey(aliasFor(vaultId));
            if (key == null) {
                clearSecret(vaultId);
                call.reject("No biometric secret stored", "no-secret");
                return;
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
            authenticate(call, cipher, "Unlock your vault", new AuthAction() {
                @Override
                public void run(Cipher authed) throws Exception {
                    byte[] pt;
                    try {
                        pt = authed.doFinal(ct);
                    } catch (GeneralSecurityException e) {
                        // The gate opened and the key loaded, but the stored ciphertext will not
                        // decrypt under it: an enable that replaced the key without writing its
                        // ciphertext. The cache can never open again, so drop it rather than fail
                        // this way forever - the same treatment KeyPermanentlyInvalidated gets.
                        // AEADBadTagException usually carries no message, which is where the
                        // "Biometric crypto failed: null" on screen came from.
                        clearSecret(vaultId);
                        call.reject("Biometric cache could not be opened; it has been cleared", "invalidated");
                        return;
                    }
                    JSObject ret = new JSObject();
                    ret.put("secret", new String(pt, StandardCharsets.UTF_8));
                    call.resolve(ret);
                }
            });
        } catch (KeyPermanentlyInvalidatedException e) {
            // The enrolled biometric set changed; the cache is dead. Drop it so the UI
            // falls back to the password screen and offers re-enabling.
            clearSecret(vaultId);
            call.reject("Biometric set changed; unlock cache cleared", "invalidated");
        } catch (Exception e) {
            call.reject("Couldn't read the stored secret: " + e.getMessage(), "auth-failed");
        }
    }

    @PluginMethod
    public void deleteSecret(PluginCall call) {
        String vaultId = call.getString("vaultId");
        if (vaultId == null) {
            call.reject("Missing vaultId");
            return;
        }
        clearSecret(vaultId);
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
                                || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON) {
                            call.reject("Cancelled", "cancelled");
                        } else if (code == BiometricPrompt.ERROR_CANCELED) {
                            // The OS pulled the prompt, not the user. The caller may ask again.
                            call.reject("Interrupted", "interrupted");
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

    private void clearSecret(String vaultId) {
        prefs().edit().remove(ctKey(vaultId)).remove(ivKey(vaultId)).apply();
        try {
            deleteKey(aliasFor(vaultId));
        } catch (Exception ignored) {
        }
    }

    private SecretKey generateKey(String alias) throws Exception {
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(alias,
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

    private SecretKey loadKey(String alias) throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        return (SecretKey) ks.getKey(alias, null);
    }

    private void deleteKey(String alias) throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(alias)) {
            ks.deleteEntry(alias);
        }
    }
}
