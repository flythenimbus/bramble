package app.bramble.mobile

// Shared identifiers for the native Android AutofillService and its unlock Activity.
// The Android peer of iOS BrambleConstants.swift. The biometric alias + prefs MUST match
// BiometricVaultPlugin.java byte-for-byte so the service and the app share one
// biometric-gated VEK cache. The Capacitor storage names mirror how the webview adapters
// (storage.ts: Filesystem Directory.Data + Preferences "CapacitorStorage") persist data,
// which the service reads directly (it runs in our own package). See docs/mobile-port.md.
object BrambleAutofill {
    // Biometric-gated VEK cache, shared with BiometricVaultPlugin.java (origin of truth).
    const val BIOMETRIC_KEYSTORE = "AndroidKeyStore"
    const val BIOMETRIC_KEY_ALIAS = "bramble.biometric.vek"
    const val BIOMETRIC_PREFS = "biometric_vault"
    const val BIOMETRIC_PREF_CT = "vek_ct"
    const val BIOMETRIC_PREF_IV = "vek_iv"

    // Keep-unlocked session: a device-unlock-gated, time-limited VEK cache so fills within
    // the window skip re-auth. The Android peer of the iOS Keychain session item.
    const val SESSION_KEY_ALIAS = "bramble.autofill.session"
    const val SESSION_PREFS = "autofill_session"
    const val SESSION_PREF_CT = "vek_ct"
    const val SESSION_PREF_IV = "vek_iv"
    const val SESSION_PREF_AT = "vek_at"

    // Capacitor storage: the encrypted VLT1 blob (Filesystem Directory.Data = getFilesDir)
    // and the metadata prefs (Preferences default group), both written by the webview. Every
    // vault is namespaced `vault-<id>.vlt1`; VAULT_FILE is the pre-namespacing fixed path the
    // one-time migration retires (still read as a fallback until the app next runs it).
    const val VAULT_FILE = "vault.vlt1"
    const val CAPACITOR_PREFS = "CapacitorStorage"

    // The single-active vault + the registry the webview writes via storage.ts setMeta (JSON-encoded
    // under a "meta:" prefix). The service reads them to target the same vault the app is in.
    // active-vault is a JSON string ("<id>"); vault.registry is `{"vaults":[{"id":...}]}`. Mirrors
    // ACTIVE_VAULT_KEY / VAULT_REGISTRY_KEY (sync-manager activeVaultId, storage.ts blobFileFor).
    const val PREF_ACTIVE_VAULT = "meta:active-vault"
    const val PREF_VAULT_REGISTRY = "meta:vault.registry"

    // Preference keys (usePrefs.tsx), stored under a "meta:" prefix as JSON by storage.ts.
    const val PREF_AUTOLOCK_MINUTES = "meta:pref.autoLockMinutes"
    const val PREF_AUTOFILL_QUICKTYPE = "meta:pref.autofillQuickType"
    const val PREF_OFFER_TO_SAVE = "meta:pref.offerToSave"
    const val PREF_NEVER_SAVE_SITES = "meta:pref.neverSaveSites"

    const val DEFAULT_AUTOLOCK_MINUTES = 15
    const val DEFAULT_OFFER_TO_SAVE = true

    const val LOG_TAG = "BrambleAutofill"
}
