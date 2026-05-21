use std::sync::{Mutex, OnceLock};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

type HmacSha256 = Hmac<Sha256>;

const ARGON2_TIME: u32 = 3;
const ARGON2_MEM_KIB: u32 = 64 * 1024;
const ARGON2_PARALLELISM: u32 = 1;
const KEY_LEN: usize = 32;
const DEK_LEN: usize = 32;
const IV_LEN: usize = 12;
const SALT_LEN: usize = 16;

fn master_slot() -> &'static Mutex<Option<Zeroizing<[u8; KEY_LEN]>>> {
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

fn derive_key(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; KEY_LEN]>, JsError> {
    let params = Params::new(ARGON2_MEM_KIB, ARGON2_TIME, ARGON2_PARALLELISM, Some(KEY_LEN))
        .map_err(|e| err(format!("argon2 params: {e}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    argon2
        .hash_password_into(password.as_bytes(), salt, out.as_mut_slice())
        .map_err(|e| err(format!("argon2 hash: {e}")))?;
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

fn with_key<F, R>(f: F) -> Result<R, JsError>
where
    F: FnOnce(&[u8]) -> Result<R, JsError>,
{
    let guard = master_slot().lock().unwrap();
    let key = guard.as_ref().ok_or_else(|| err("vault is locked"))?;
    f(key.as_slice())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedPayload {
    ciphertext: String,
    iv: String,
    wrapped_dek: String,
    dek_iv: String,
}

#[wasm_bindgen]
pub fn unlock(password: String, salt_b64: String) -> Result<(), JsError> {
    let salt = b64_decode(&salt_b64)?;
    let key = derive_key(&password, &salt)?;
    *master_slot().lock().unwrap() = Some(key);
    Ok(())
}

#[wasm_bindgen]
pub fn lock() {
    *master_slot().lock().unwrap() = None;
}

#[wasm_bindgen]
pub fn is_locked() -> bool {
    master_slot().lock().unwrap().is_none()
}

#[wasm_bindgen]
pub fn encrypt_entry(plaintext_json: String) -> Result<JsValue, JsError> {
    let payload = with_key(|master| {
        let mut dek = Zeroizing::new([0u8; DEK_LEN]);
        random_bytes(dek.as_mut_slice())?;

        let mut iv = [0u8; IV_LEN];
        random_bytes(&mut iv)?;

        let mut dek_iv = [0u8; IV_LEN];
        random_bytes(&mut dek_iv)?;

        let ciphertext = aes_encrypt(dek.as_slice(), &iv, plaintext_json.as_bytes())?;
        let wrapped_dek = aes_encrypt(master, &dek_iv, dek.as_slice())?;

        Ok(EncryptedPayload {
            ciphertext: B64.encode(&ciphertext),
            iv: B64.encode(iv),
            wrapped_dek: B64.encode(&wrapped_dek),
            dek_iv: B64.encode(dek_iv),
        })
    })?;

    serde_wasm_bindgen::to_value(&payload).map_err(|e| err(format!("serialize: {e}")))
}

#[wasm_bindgen]
pub fn decrypt_entry(
    ciphertext: String,
    iv: String,
    wrapped_dek: String,
    dek_iv: String,
) -> Result<String, JsError> {
    with_key(|master| {
        let ct = b64_decode(&ciphertext)?;
        let iv = iv_from(b64_decode(&iv)?)?;
        let wrapped = b64_decode(&wrapped_dek)?;
        let dek_iv = iv_from(b64_decode(&dek_iv)?)?;

        let dek = aes_decrypt(master, &dek_iv, &wrapped)?;
        let plaintext = aes_decrypt(dek.as_slice(), &iv, &ct)?;
        String::from_utf8(plaintext.to_vec()).map_err(|e| err(format!("utf8: {e}")))
    })
}

#[wasm_bindgen]
pub fn generate_salt() -> Result<String, JsError> {
    let mut salt = [0u8; SALT_LEN];
    random_bytes(&mut salt)?;
    Ok(B64.encode(salt))
}

#[wasm_bindgen]
pub fn verifier_for(magic: &[u8]) -> Result<Vec<u8>, JsError> {
    with_key(|master| {
        let mut mac = <HmacSha256 as Mac>::new_from_slice(master)
            .expect("hmac accepts any key length");
        mac.update(magic);
        Ok(mac.finalize().into_bytes().to_vec())
    })
}

#[wasm_bindgen]
pub fn change_password(
    new_password: String,
    new_salt_b64: String,
    entries: JsValue,
) -> Result<JsValue, JsError> {
    let entries: Vec<EncryptedPayload> = serde_wasm_bindgen::from_value(entries)
        .map_err(|e| err(format!("entries deserialize: {e}")))?;

    let new_salt = b64_decode(&new_salt_b64)?;
    let new_key = derive_key(&new_password, &new_salt)?;

    let new_entries = with_key(|old_master| {
        let mut result = Vec::with_capacity(entries.len());
        for entry in entries {
            let wrapped = b64_decode(&entry.wrapped_dek)?;
            let dek_iv = iv_from(b64_decode(&entry.dek_iv)?)?;
            let dek = aes_decrypt(old_master, &dek_iv, &wrapped)?;

            let mut new_dek_iv = [0u8; IV_LEN];
            random_bytes(&mut new_dek_iv)?;
            let new_wrapped = aes_encrypt(new_key.as_slice(), &new_dek_iv, dek.as_slice())?;

            result.push(EncryptedPayload {
                ciphertext: entry.ciphertext,
                iv: entry.iv,
                wrapped_dek: B64.encode(&new_wrapped),
                dek_iv: B64.encode(new_dek_iv),
            });
        }
        Ok(result)
    })?;

    *master_slot().lock().unwrap() = Some(new_key);

    serde_wasm_bindgen::to_value(&new_entries).map_err(|e| err(format!("serialize: {e}")))
}
