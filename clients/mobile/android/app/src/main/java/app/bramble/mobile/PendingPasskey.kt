package app.bramble.mobile

import android.content.Context

// Create-side handoff for the Credential Manager passkey provider. The fulfill activity mints a
// passkey but must NOT write the vault (single-writer + sync HLC stamping live in the main app),
// so it stashes the new credential here - VEK-encrypted, so the private key is never at rest in
// clear - and the app drains + persists it on next launch (core usePendingHandoffs). See
// EncryptedHandoff and docs/passkey-provider.md.
object PendingPasskey {
    const val FILE = "autofill_pending_passkeys.json"

    // `credentialJson` is a full PasskeyCredential (mirrors core's). The caller MUST have the VEK
    // loaded (it just unlocked to mint). Appends so multiple creates before a launch all survive.
    fun write(context: Context, credentialJson: String) = EncryptedHandoff.append(context, FILE, credentialJson)
}
