//! Vault crypto: VEK-based key wrapping (password/WebAuthn slots) and entry encryption.

use std::sync::{Mutex, OnceLock};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

// KDBX4 import (not wasm-exported yet).
mod kdbx;

const ARGON2_TIME: u32 = 3;
const ARGON2_MEM_KIB: u32 = 64 * 1024;
const ARGON2_PARALLELISM: u32 = 1;
const KEY_LEN: usize = 32;
const DEK_LEN: usize = 32;
const IV_LEN: usize = 12;
const SALT_LEN: usize = 16;
const SLOT_ID_LEN: usize = 16;

/// In-memory slot holding the Vault Encryption Key (VEK). Every key-slot wraps a
/// copy of the VEK; unlocking unwraps it and loads it here.
fn vek_slot() -> &'static Mutex<Option<Zeroizing<[u8; KEY_LEN]>>> {
    static SLOT: OnceLock<Mutex<Option<Zeroizing<[u8; KEY_LEN]>>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn err(msg: impl Into<String>) -> JsError {
    JsError::new(&msg.into())
}

fn random_bytes(buf: &mut [u8]) -> Result<(), JsError> {
    getrandom::getrandom(buf).map_err(|e| err(format!("rng: {e}")))
}

fn b64_decode(s: &str) -> Result<Vec<u8>, JsError> {
    B64.decode(s.as_bytes()).map_err(|e| err(format!("base64: {e}")))
}

fn iv_from(bytes: Vec<u8>) -> Result<[u8; IV_LEN], JsError> {
    bytes.try_into().map_err(|_| err("iv must be 12 bytes"))
}

/// Derive a 32-byte KEK from a password and salt via Argon2id.
fn derive_kek(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; KEY_LEN]>, JsError> {
    let params = Params::new(ARGON2_MEM_KIB, ARGON2_TIME, ARGON2_PARALLELISM, Some(KEY_LEN))
        .map_err(|e| err(format!("argon2 params: {e}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    argon2
        .hash_password_into(password.as_bytes(), salt, out.as_mut_slice())
        .map_err(|e| err(format!("argon2 hash: {e}")))?;
    Ok(out)
}

const WEBAUTHN_KDF_INFO: &[u8] = b"titanpass/webauthn/v1";
/// Derive a 32-byte KEK from an authenticator hmac-secret via HKDF-SHA256,
/// domain-separated by WEBAUTHN_KDF_INFO.
fn derive_kek_hkdf(hmac_secret: &[u8]) -> Result<Zeroizing<[u8; KEY_LEN]>, JsError> {
    let hkdf = Hkdf::<Sha256>::new(None, hmac_secret);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    hkdf.expand(WEBAUTHN_KDF_INFO, out.as_mut_slice())
        .map_err(|e| err(format!("hkdf expand: {e}")))?;
    Ok(out)
}

fn aes_encrypt(key: &[u8], iv: &[u8; IV_LEN], plaintext: &[u8]) -> Result<Vec<u8>, JsError> {
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| err("key must be 32 bytes"))?
        .encrypt(Nonce::from_slice(iv), plaintext)
        .map_err(|e| err(format!("aes encrypt: {e}")))
}

fn aes_decrypt(key: &[u8], iv: &[u8; IV_LEN], ct: &[u8]) -> Result<Zeroizing<Vec<u8>>, JsError> {
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| err("key must be 32 bytes"))?
        .decrypt(Nonce::from_slice(iv), ct)
        .map(Zeroizing::new)
        .map_err(|e| err(format!("aes decrypt: {e}")))
}

fn with_vek<F, R>(f: F) -> Result<R, JsError>
where
    F: FnOnce(&[u8]) -> Result<R, JsError>,
{
    let guard = vek_slot().lock().unwrap();
    let key = guard.as_ref().ok_or_else(|| err("vault is locked"))?;
    f(key.as_slice())
}

fn load_vek(bytes: &[u8]) -> Result<(), JsError> {
    if bytes.len() != KEY_LEN {
        return Err(err(format!("VEK must be {} bytes", KEY_LEN)));
    }
    let mut z = Zeroizing::new([0u8; KEY_LEN]);
    z.copy_from_slice(bytes);
    *vek_slot().lock().unwrap() = Some(z);
    Ok(())
}

/// Verifier domain: HMAC-SHA256(KEK, magic_version || slot_id). Compared in
/// constant time on unlock to reject wrong credentials before the AES-GCM unwrap.
fn compute_verifier(kek: &[u8], magic_version: &[u8], slot_id: &[u8]) -> Vec<u8> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(kek).expect("hmac accepts any key length");
    mac.update(magic_version);
    mac.update(slot_id);
    mac.finalize().into_bytes().to_vec()
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedPayload {
    ciphertext: String,
    iv: String,
    wrapped_dek: String,
    dek_iv: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MasterEncrypted {
    iv: String,
    ciphertext: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordSlotBlob {
    verifier: String,
    wrap_iv: String,
    wrapped_vek: String,
}

/// Whether the vault is locked (no VEK in memory).
#[wasm_bindgen]
pub fn is_locked() -> bool {
    vek_slot().lock().unwrap().is_none()
}

/// Clear the VEK from memory, locking the vault.
#[wasm_bindgen]
pub fn lock() {
    *vek_slot().lock().unwrap() = None;
}

/// Generate a fresh VEK at vault creation, load it into memory, and return it
/// base64-encoded.
#[wasm_bindgen]
pub fn generate_vek() -> Result<String, JsError> {
    let mut vek = [0u8; KEY_LEN];
    random_bytes(&mut vek)?;
    let encoded = B64.encode(vek);
    load_vek(&vek)?;
    Ok(encoded)
}

/// Session resume: load a cached VEK (from chrome.storage.session) without
/// re-deriving from a credential.
#[wasm_bindgen]
pub fn unlock_with_vek(vek_b64: String) -> Result<(), JsError> {
    let bytes = b64_decode(&vek_b64)?;
    load_vek(&bytes)
}

/// Return the in-memory VEK base64-encoded (for session caching). Errors if locked.
#[wasm_bindgen]
pub fn export_vek() -> Result<String, JsError> {
    let guard = vek_slot().lock().unwrap();
    let key = guard.as_ref().ok_or_else(|| err("vault is locked"))?;
    Ok(B64.encode(key.as_slice()))
}

/// Generate a fresh VEK and replace the in-memory one (caller must re-wrap every
/// slot). Refuses to run on a locked vault to avoid dropping the old key material.
#[wasm_bindgen]
pub fn rotate_vek() -> Result<String, JsError> {
    if vek_slot().lock().unwrap().is_none() {
        return Err(err("vault is locked"));
    }
    let mut new_vek = [0u8; KEY_LEN];
    random_bytes(&mut new_vek)?;
    let encoded = B64.encode(new_vek);
    load_vek(&new_vek)?;
    Ok(encoded)
}

/// Generate a random base64 salt for a password slot.
#[wasm_bindgen]
pub fn generate_salt() -> Result<String, JsError> {
    let mut salt = [0u8; SALT_LEN];
    random_bytes(&mut salt)?;
    Ok(B64.encode(salt))
}

/// Generate a random base64 slot id.
#[wasm_bindgen]
pub fn generate_slot_id() -> Result<String, JsError> {
    let mut id = [0u8; SLOT_ID_LEN];
    random_bytes(&mut id)?;
    Ok(B64.encode(id))
}

/// Wrap the in-memory VEK under a KEK derived from `password` + `salt`. Returns
/// the slot's verifier, wrapIv, and wrappedVek for the vault header.
#[wasm_bindgen]
pub fn wrap_vek_password(
    password: String,
    salt_b64: String,
    slot_id_b64: String,
    magic_version: Vec<u8>,
) -> Result<JsValue, JsError> {
    let salt = b64_decode(&salt_b64)?;
    let slot_id = b64_decode(&slot_id_b64)?;
    let kek = derive_kek(&password, &salt)?;

    let payload = with_vek(|vek| {
        let mut wrap_iv = [0u8; IV_LEN];
        random_bytes(&mut wrap_iv)?;
        let wrapped = aes_encrypt(kek.as_slice(), &wrap_iv, vek)?;
        let verifier = compute_verifier(kek.as_slice(), &magic_version, &slot_id);
        Ok(PasswordSlotBlob {
            verifier: B64.encode(&verifier),
            wrap_iv: B64.encode(wrap_iv),
            wrapped_vek: B64.encode(&wrapped),
        })
    })?;

    serde_wasm_bindgen::to_value(&payload).map_err(|e| err(format!("serialize: {e}")))
}

/// Verifier-only check (constant-time, no VEK unwrap): does `password` match this
/// slot's stored verifier? Works while the vault is already unlocked.
#[wasm_bindgen]
pub fn verify_password_slot(
    password: String,
    salt_b64: String,
    slot_id_b64: String,
    verifier_b64: String,
    magic_version: Vec<u8>,
) -> Result<bool, JsError> {
    let salt = b64_decode(&salt_b64)?;
    let slot_id = b64_decode(&slot_id_b64)?;
    let verifier = b64_decode(&verifier_b64)?;
    let kek = derive_kek(&password, &salt)?;
    let computed = compute_verifier(kek.as_slice(), &magic_version, &slot_id);
    Ok(ct_eq(&computed, &verifier))
}

/// Full unlock: verify, then unwrap the VEK and load it into memory. Returns
/// false (without mutating state) if the verifier doesn't match.
#[wasm_bindgen]
pub fn unwrap_vek_password(
    password: String,
    salt_b64: String,
    slot_id_b64: String,
    verifier_b64: String,
    wrap_iv_b64: String,
    wrapped_vek_b64: String,
    magic_version: Vec<u8>,
) -> Result<bool, JsError> {
    let salt = b64_decode(&salt_b64)?;
    let slot_id = b64_decode(&slot_id_b64)?;
    let verifier = b64_decode(&verifier_b64)?;
    let kek = derive_kek(&password, &salt)?;

    let computed = compute_verifier(kek.as_slice(), &magic_version, &slot_id);
    if !ct_eq(&computed, &verifier) {
        return Ok(false);
    }

    let wrap_iv = iv_from(b64_decode(&wrap_iv_b64)?)?;
    let wrapped = b64_decode(&wrapped_vek_b64)?;
    let vek = aes_decrypt(kek.as_slice(), &wrap_iv, &wrapped)?;
    load_vek(vek.as_slice())?;
    Ok(true)
}

// WebAuthn slots use the same mechanics as password slots; only the KEK source
// differs (HKDF over a FIDO2 authenticator hmac-secret instead of Argon2id).

/// Wrap the in-memory VEK under a KEK derived from an authenticator hmac-secret.
#[wasm_bindgen]
pub fn wrap_vek_webauthn(
    hmac_secret_b64: String,
    slot_id_b64: String,
    magic_version: Vec<u8>,
) -> Result<JsValue, JsError> {
    let hmac_secret = b64_decode(&hmac_secret_b64)?;
    let slot_id = b64_decode(&slot_id_b64)?;
    let kek = derive_kek_hkdf(&hmac_secret)?;

    let payload = with_vek(|vek| {
        let mut wrap_iv = [0u8; IV_LEN];
        random_bytes(&mut wrap_iv)?;
        let wrapped = aes_encrypt(kek.as_slice(), &wrap_iv, vek)?;
        let verifier = compute_verifier(kek.as_slice(), &magic_version, &slot_id);
        Ok(PasswordSlotBlob {
            verifier: B64.encode(&verifier),
            wrap_iv: B64.encode(wrap_iv),
            wrapped_vek: B64.encode(&wrapped),
        })
    })?;

    serde_wasm_bindgen::to_value(&payload).map_err(|e| err(format!("serialize: {e}")))
}

/// Verifier-only check for a WebAuthn slot (constant-time, no VEK unwrap).
#[wasm_bindgen]
pub fn verify_webauthn_slot(
    hmac_secret_b64: String,
    slot_id_b64: String,
    verifier_b64: String,
    magic_version: Vec<u8>,
) -> Result<bool, JsError> {
    let hmac_secret = b64_decode(&hmac_secret_b64)?;
    let slot_id = b64_decode(&slot_id_b64)?;
    let verifier = b64_decode(&verifier_b64)?;
    let kek = derive_kek_hkdf(&hmac_secret)?;
    let computed = compute_verifier(kek.as_slice(), &magic_version, &slot_id);
    Ok(ct_eq(&computed, &verifier))
}

/// Full WebAuthn unlock: verify, then unwrap the VEK into memory. Returns false
/// (without mutating state) if the verifier doesn't match.
#[wasm_bindgen]
pub fn unwrap_vek_webauthn(
    hmac_secret_b64: String,
    slot_id_b64: String,
    verifier_b64: String,
    wrap_iv_b64: String,
    wrapped_vek_b64: String,
    magic_version: Vec<u8>,
) -> Result<bool, JsError> {
    let hmac_secret = b64_decode(&hmac_secret_b64)?;
    let slot_id = b64_decode(&slot_id_b64)?;
    let verifier = b64_decode(&verifier_b64)?;
    let kek = derive_kek_hkdf(&hmac_secret)?;

    let computed = compute_verifier(kek.as_slice(), &magic_version, &slot_id);
    if !ct_eq(&computed, &verifier) {
        return Ok(false);
    }

    let wrap_iv = iv_from(b64_decode(&wrap_iv_b64)?)?;
    let wrapped = b64_decode(&wrapped_vek_b64)?;
    let vek = aes_decrypt(kek.as_slice(), &wrap_iv, &wrapped)?;
    load_vek(vek.as_slice())?;
    Ok(true)
}

/// Encrypt an entry: random DEK encrypts the plaintext, VEK wraps the DEK.
#[wasm_bindgen]
pub fn encrypt_entry(plaintext_json: String) -> Result<JsValue, JsError> {
    let payload = with_vek(|vek| {
        let mut dek = Zeroizing::new([0u8; DEK_LEN]);
        random_bytes(dek.as_mut_slice())?;

        let mut iv = [0u8; IV_LEN];
        random_bytes(&mut iv)?;

        let mut dek_iv = [0u8; IV_LEN];
        random_bytes(&mut dek_iv)?;

        let ciphertext = aes_encrypt(dek.as_slice(), &iv, plaintext_json.as_bytes())?;
        let wrapped_dek = aes_encrypt(vek, &dek_iv, dek.as_slice())?;

        Ok(EncryptedPayload {
            ciphertext: B64.encode(&ciphertext),
            iv: B64.encode(iv),
            wrapped_dek: B64.encode(&wrapped_dek),
            dek_iv: B64.encode(dek_iv),
        })
    })?;

    serde_wasm_bindgen::to_value(&payload).map_err(|e| err(format!("serialize: {e}")))
}

/// Decrypt an entry: VEK unwraps the DEK, the DEK decrypts the plaintext.
#[wasm_bindgen]
pub fn decrypt_entry(
    ciphertext: String,
    iv: String,
    wrapped_dek: String,
    dek_iv: String,
) -> Result<String, JsError> {
    with_vek(|vek| {
        let ct = b64_decode(&ciphertext)?;
        let iv = iv_from(b64_decode(&iv)?)?;
        let wrapped = b64_decode(&wrapped_dek)?;
        let dek_iv = iv_from(b64_decode(&dek_iv)?)?;

        let dek = aes_decrypt(vek, &dek_iv, &wrapped)?;
        let plaintext = aes_decrypt(dek.as_slice(), &iv, &ct)?;
        String::from_utf8(plaintext.to_vec()).map_err(|e| err(format!("utf8: {e}")))
    })
}

/// Encrypt plaintext directly under the VEK (no per-item DEK).
#[wasm_bindgen]
pub fn encrypt_with_vek(plaintext: String) -> Result<JsValue, JsError> {
    let payload = with_vek(|vek| {
        let mut iv = [0u8; IV_LEN];
        random_bytes(&mut iv)?;
        let ct = aes_encrypt(vek, &iv, plaintext.as_bytes())?;
        Ok(MasterEncrypted {
            iv: B64.encode(iv),
            ciphertext: B64.encode(&ct),
        })
    })?;
    serde_wasm_bindgen::to_value(&payload).map_err(|e| err(format!("serialize: {e}")))
}

/// Decrypt ciphertext encrypted directly under the VEK.
#[wasm_bindgen]
pub fn decrypt_with_vek(iv_b64: String, ciphertext_b64: String) -> Result<String, JsError> {
    with_vek(|vek| {
        let iv = iv_from(b64_decode(&iv_b64)?)?;
        let ct = b64_decode(&ciphertext_b64)?;
        let plaintext = aes_decrypt(vek, &iv, &ct)?;
        String::from_utf8(plaintext.to_vec()).map_err(|e| err(format!("utf8: {e}")))
    })
}

// Drive the primitives directly with known IVs/keys/salts; the global VEK slot
// makes the #[wasm_bindgen] wrappers awkward to test in parallel.
#[cfg(test)]
mod tests {
    use super::*;

    /// Measure the configured vault Argon2id cost. Native release is a lower
    /// bound; browser WASM runs ~2-3x slower. Run with:
    ///   cargo test --release bench_vault_kek_derive -- --ignored --nocapture
    #[test]
    #[ignore = "benchmark"]
    fn bench_vault_kek_derive() {
        use std::time::Instant;
        let salt = [0u8; SALT_LEN];
        let pw = "correct horse battery staple";
        let _ = derive_kek(pw, &salt).unwrap(); // warm up
        let runs = 5;
        let start = Instant::now();
        for _ in 0..runs {
            let _ = derive_kek(pw, &salt).unwrap();
        }
        let per = start.elapsed() / runs;
        println!(
            "Argon2id m={}MiB t={} p={}: {per:?}/derive (native release)",
            ARGON2_MEM_KIB / 1024,
            ARGON2_TIME,
            ARGON2_PARALLELISM,
        );
    }

    #[test]
    fn derive_kek_hkdf_is_deterministic_and_32_bytes() {
        let secret = [0xa5u8; 32];
        let a = derive_kek_hkdf(&secret).unwrap();
        let b = derive_kek_hkdf(&secret).unwrap();
        assert_eq!(a.as_slice().len(), KEY_LEN);
        assert_eq!(a.as_slice(), b.as_slice());
    }

    #[test]
    fn derive_kek_hkdf_different_secrets_give_different_keks() {
        let kek_a = derive_kek_hkdf(&[0x01u8; 32]).unwrap();
        let kek_b = derive_kek_hkdf(&[0x02u8; 32]).unwrap();
        assert_ne!(kek_a.as_slice(), kek_b.as_slice());
    }

    // Full wrap/verify/unwrap round-trip with fixed inputs: catches any wiring
    // bug in the HKDF info string, verifier domain bytes, or AES-GCM IV plumbing.
    #[test]
    fn webauthn_wrap_unwrap_round_trip() {
        let vek: [u8; KEY_LEN] = [0x42; KEY_LEN];
        let hmac_secret: [u8; 32] = [0xc3; 32];
        let slot_id: [u8; SLOT_ID_LEN] = [0x10; SLOT_ID_LEN];
        let magic_version: [u8; 5] = [b'V', b'L', b'T', b'1', 0x02];
        let wrap_iv: [u8; IV_LEN] = [0x77; IV_LEN];

        let kek = derive_kek_hkdf(&hmac_secret).unwrap();
        let wrapped = aes_encrypt(kek.as_slice(), &wrap_iv, &vek).unwrap();
        let verifier = compute_verifier(kek.as_slice(), &magic_version, &slot_id);
        assert_eq!(verifier.len(), 32, "verifier must be HMAC-SHA256 sized");

        let kek2 = derive_kek_hkdf(&hmac_secret).unwrap();
        let computed = compute_verifier(kek2.as_slice(), &magic_version, &slot_id);
        assert!(ct_eq(&computed, &verifier), "verifier round-trip mismatch");
        let recovered = aes_decrypt(kek2.as_slice(), &wrap_iv, &wrapped).unwrap();
        assert_eq!(recovered.as_slice(), vek);
    }

    // Wrong hmac-secret yields a different verifier (attacker has the wrappedVek
    // but the wrong secret).
    #[test]
    fn webauthn_unwrap_rejects_wrong_hmac_secret() {
        let slot_id: [u8; SLOT_ID_LEN] = [0x10; SLOT_ID_LEN];
        let magic_version: [u8; 5] = [b'V', b'L', b'T', b'1', 0x02];

        let kek_real = derive_kek_hkdf(&[0xaa; 32]).unwrap();
        let kek_attacker = derive_kek_hkdf(&[0xab; 32]).unwrap();
        let verifier_real = compute_verifier(kek_real.as_slice(), &magic_version, &slot_id);
        let verifier_attacker =
            compute_verifier(kek_attacker.as_slice(), &magic_version, &slot_id);
        assert!(!ct_eq(&verifier_real, &verifier_attacker));
    }

    // A tampered verifier byte fails ct_eq (on-disk tampering between wrap and unwrap).
    #[test]
    fn webauthn_unwrap_rejects_tampered_verifier() {
        let hmac_secret: [u8; 32] = [0xc3; 32];
        let slot_id: [u8; SLOT_ID_LEN] = [0x10; SLOT_ID_LEN];
        let magic_version: [u8; 5] = [b'V', b'L', b'T', b'1', 0x02];

        let kek = derive_kek_hkdf(&hmac_secret).unwrap();
        let mut verifier = compute_verifier(kek.as_slice(), &magic_version, &slot_id);
        verifier[0] ^= 0x01;
        let recomputed = compute_verifier(kek.as_slice(), &magic_version, &slot_id);
        assert!(!ct_eq(&recomputed, &verifier));
    }

    // Tampered ciphertext fails the AES-GCM tag check. Calls the crate directly
    // because `aes_decrypt` returns JsError, not constructable off wasm.
    #[test]
    fn webauthn_unwrap_rejects_tampered_ciphertext() {
        use aes_gcm::aead::Aead;
        let vek: [u8; KEY_LEN] = [0x42; KEY_LEN];
        let hmac_secret: [u8; 32] = [0xc3; 32];
        let wrap_iv: [u8; IV_LEN] = [0x77; IV_LEN];

        let kek = derive_kek_hkdf(&hmac_secret).unwrap();
        let mut wrapped = aes_encrypt(kek.as_slice(), &wrap_iv, &vek).unwrap();
        wrapped[0] ^= 0x01;
        let cipher = Aes256Gcm::new_from_slice(kek.as_slice()).unwrap();
        let result = cipher.decrypt(Nonce::from_slice(&wrap_iv), wrapped.as_slice());
        assert!(result.is_err(), "AES-GCM should reject a flipped ciphertext bit");
    }

    // The WebAuthn and password KEK derivations must not collide even on shared
    // input bytes (different algos: HKDF vs Argon2id).
    #[test]
    fn webauthn_kek_differs_from_password_kek_on_same_bytes() {
        let bytes = [0x33u8; 32];
        let webauthn_kek = derive_kek_hkdf(&bytes).unwrap();
        let password_kek = derive_kek("\u{0033}".repeat(32).as_str(), &bytes[..16]).unwrap();
        assert_ne!(webauthn_kek.as_slice(), password_kek.as_slice());
    }
}
