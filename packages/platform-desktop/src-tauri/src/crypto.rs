//! The vault crypto core, exposed to the webview as Tauri commands.
//!
//! Every command is a thin wrapper over `vault_crypto`, which this crate links as an
//! ordinary cargo dependency. The VEK therefore lives in this process and never crosses
//! into the webview, which is the desktop equivalent of the extension's offscreen document
//! and mobile's native plugin. See docs/desktop-port.md.
//!
//! The core's structs already serialize camelCase, so they land on the TS side matching
//! `@core/adapters/crypto` exactly and need no mapping layer.

use vault_crypto::{CryptoError, EncryptedPayload, MasterEncrypted, PasswordSlotBlob};

/// Errors ride to JS as a plain string, which `invoke` rejects with. The core already
/// sanitizes these (no key material in a message), so passing Display through is safe.
type CmdResult<T> = Result<T, String>;

fn map<T>(r: Result<T, CryptoError>) -> CmdResult<T> {
    r.map_err(|e| e.to_string())
}

// ---- VEK lifecycle ----

#[tauri::command]
pub fn crypto_is_locked() -> bool {
    vault_crypto::is_locked()
}

#[tauri::command]
pub fn crypto_lock() {
    vault_crypto::lock()
}

#[tauri::command]
pub fn crypto_generate_vek() -> CmdResult<String> {
    map(vault_crypto::generate_vek())
}

#[tauri::command]
pub fn crypto_unlock_with_vek(vek_b64: String) -> CmdResult<()> {
    map(vault_crypto::unlock_with_vek(vek_b64))
}

#[tauri::command]
pub fn crypto_export_vek() -> CmdResult<String> {
    map(vault_crypto::export_vek())
}

#[tauri::command]
pub fn crypto_rotate_vek() -> CmdResult<String> {
    map(vault_crypto::rotate_vek())
}

// ---- slot material ----

#[tauri::command]
pub fn crypto_generate_salt() -> CmdResult<String> {
    map(vault_crypto::generate_salt())
}

#[tauri::command]
pub fn crypto_generate_slot_id() -> CmdResult<String> {
    map(vault_crypto::generate_slot_id())
}

// ---- password slots ----

#[tauri::command]
pub fn crypto_wrap_vek_password(
    password: String,
    salt_b64: String,
    slot_id_b64: String,
    magic_version: Vec<u8>,
) -> CmdResult<PasswordSlotBlob> {
    map(vault_crypto::wrap_vek_password(
        password,
        salt_b64,
        slot_id_b64,
        magic_version,
    ))
}

#[tauri::command]
pub fn crypto_unwrap_vek_password(
    password: String,
    salt_b64: String,
    slot_id_b64: String,
    verifier_b64: String,
    wrap_iv_b64: String,
    wrapped_vek_b64: String,
    magic_version: Vec<u8>,
) -> CmdResult<bool> {
    map(vault_crypto::unwrap_vek_password(
        password,
        salt_b64,
        slot_id_b64,
        verifier_b64,
        wrap_iv_b64,
        wrapped_vek_b64,
        magic_version,
    ))
}

#[tauri::command]
pub fn crypto_verify_password_slot(
    password: String,
    salt_b64: String,
    slot_id_b64: String,
    verifier_b64: String,
    magic_version: Vec<u8>,
) -> CmdResult<bool> {
    map(vault_crypto::verify_password_slot(
        password,
        salt_b64,
        slot_id_b64,
        verifier_b64,
        magic_version,
    ))
}

// ---- security-key slots ----
// Wired because the core calls are free, though `securityKeys` is off for desktop in
// flags.ts until there is a native CTAP path (the webview has no usable WebAuthn).

#[tauri::command]
pub fn crypto_wrap_vek_webauthn(
    hmac_secret_b64: String,
    slot_id_b64: String,
    magic_version: Vec<u8>,
) -> CmdResult<PasswordSlotBlob> {
    map(vault_crypto::wrap_vek_webauthn(
        hmac_secret_b64,
        slot_id_b64,
        magic_version,
    ))
}

#[tauri::command]
pub fn crypto_unwrap_vek_webauthn(
    hmac_secret_b64: String,
    slot_id_b64: String,
    verifier_b64: String,
    wrap_iv_b64: String,
    wrapped_vek_b64: String,
    magic_version: Vec<u8>,
) -> CmdResult<bool> {
    map(vault_crypto::unwrap_vek_webauthn(
        hmac_secret_b64,
        slot_id_b64,
        verifier_b64,
        wrap_iv_b64,
        wrapped_vek_b64,
        magic_version,
    ))
}

#[tauri::command]
pub fn crypto_verify_webauthn_slot(
    hmac_secret_b64: String,
    slot_id_b64: String,
    verifier_b64: String,
    magic_version: Vec<u8>,
) -> CmdResult<bool> {
    map(vault_crypto::verify_webauthn_slot(
        hmac_secret_b64,
        slot_id_b64,
        verifier_b64,
        magic_version,
    ))
}

// ---- entries ----

#[tauri::command]
pub fn crypto_encrypt_entry(plaintext_json: String) -> CmdResult<EncryptedPayload> {
    map(vault_crypto::encrypt_entry(plaintext_json))
}

#[tauri::command]
pub fn crypto_decrypt_entry(payload: EncryptedPayload) -> CmdResult<String> {
    map(vault_crypto::decrypt_entry(
        payload.ciphertext,
        payload.iv,
        payload.wrapped_dek,
        payload.dek_iv,
    ))
}

/// Batch form: one IPC round trip for the whole vault rather than one per entry, which is
/// what dominates open time on large vaults. Order matches `payloads`.
#[tauri::command]
pub fn crypto_decrypt_entries(payloads: Vec<EncryptedPayload>) -> CmdResult<Vec<String>> {
    payloads
        .into_iter()
        .map(|p| {
            map(vault_crypto::decrypt_entry(
                p.ciphertext,
                p.iv,
                p.wrapped_dek,
                p.dek_iv,
            ))
        })
        .collect()
}

#[tauri::command]
pub fn crypto_encrypt_with_vek(plaintext: String) -> CmdResult<MasterEncrypted> {
    map(vault_crypto::encrypt_with_vek(plaintext))
}

#[tauri::command]
pub fn crypto_decrypt_with_vek(iv: String, ciphertext: String) -> CmdResult<String> {
    map(vault_crypto::decrypt_with_vek(iv, ciphertext))
}
