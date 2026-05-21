use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

// Master key lives here. Never returned to JS.
// Wrap in Zeroizing so Drop scrubs on lock or replacement.
static mut MASTER_KEY: Option<Zeroizing<[u8; 32]>> = None;

#[wasm_bindgen]
pub fn unlock(_password: String, _salt_b64: String) -> Result<(), JsError> {
    // TODO: argon2id KDF → derive master key → store in MASTER_KEY.
    Err(JsError::new("TODO: unlock"))
}

#[wasm_bindgen]
pub fn lock() {
    // Setting to None drops the Zeroizing wrapper which zeroes the bytes.
    unsafe { MASTER_KEY = None; }
}

#[wasm_bindgen]
pub fn is_locked() -> bool {
    unsafe { MASTER_KEY.is_none() }
}

#[wasm_bindgen]
pub fn encrypt_entry(_plaintext_json: String) -> Result<JsValue, JsError> {
    // TODO: generate DEK, encrypt plaintext with DEK,
    // wrap DEK with master key, return { ciphertext, iv, wrappedDek, dekIv }.
    Err(JsError::new("TODO: encrypt_entry"))
}

#[wasm_bindgen]
pub fn decrypt_entry(
    _ciphertext: String,
    _iv: String,
    _wrapped_dek: String,
    _dek_iv: String,
) -> Result<String, JsError> {
    // TODO: unwrap DEK with master key, decrypt ciphertext with DEK.
    Err(JsError::new("TODO: decrypt_entry"))
}

#[wasm_bindgen]
pub fn generate_salt() -> String {
    // TODO: 16 random bytes → base64.
    String::new()
}

#[wasm_bindgen]
pub fn verifier_for(_magic: &[u8]) -> Vec<u8> {
    // TODO: HMAC-SHA256(master_key, magic).
    Vec::new()
}

#[wasm_bindgen]
pub fn change_password(
    _new_password: String,
    _new_salt_b64: String,
    _entries: JsValue,
) -> Result<JsValue, JsError> {
    // TODO: derive new master key, rewrap every DEK, swap master key.
    Err(JsError::new("TODO: change_password"))
}
