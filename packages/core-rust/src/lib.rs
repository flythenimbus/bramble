//! Vault crypto: VEK-based key wrapping (password/WebAuthn slots) and entry encryption.
//!
//! One pure-Rust core, two binding layers selected by feature:
//! - `wasm` (default): `#[wasm_bindgen]` exports for the browser extension and the
//!   Capacitor webview.
//! - `ffi`: `uniffi` exports emitting Swift + Kotlin for the iOS autofill credential
//!   provider (which can't run Argon2id in its ~120 MB cap, so it AES-unwraps the
//!   biometric-cached VEK natively) and for Lockdown-Mode-safe main-app crypto (native
//!   code needs no JIT, unlike WASM).
//!
//! The core functions below take/return raw bytes + base64 strings and are unit-tested
//! natively. The two layers are thin: each maps `CryptoError` to its host's error type
//! and (for the few struct-returning calls) serializes the result.

use std::sync::{Mutex, OnceLock};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

type HmacSha256 = Hmac<Sha256>;

// KDBX4 import compiles into both layers: import runs in the main app, which uses
// native crypto under Lockdown Mode, so `open_kdbx4` is on the FFI surface too.
mod kdbx;
// Passkey authenticator (provider role): mint/assert WebAuthn credentials for other
// sites. Pure + sync, compiled into both layers. See docs/passkey-provider.md.
mod passkey;
// The desktop shell links this crate as an ordinary cargo dependency with no binding layer
// in between, so every type its Tauri command signatures name has to be reachable from the
// crate root (`handshake` and `nostr` are public for the same reason). Re-exported instead
// of publishing the modules, so the surface stays the entry points and their records.
#[cfg(any(feature = "ffi", feature = "native"))]
pub use kdbx::{open_kdbx4, OutEntry, OutString};
#[cfg(any(feature = "ffi", feature = "native"))]
pub use passkey::{PasskeyAssertion, PasskeyImportResult, PasskeyRegistration};
// Ed25519 device-key signing for authenticated sync-roster mutations (Item A). Pure + sync,
// compiled into both layers (all devices sign). See docs/p2p-sync-revocation-hardening.md.
pub mod roster_sig;
// SigV4 signing for S3-compatible backup targets. Only the desktop shell calls it (its webview
// cannot reach a provider: no CORS grant for `tauri://localhost`), but it is declared
// unconditionally so `cargo test` covers it in every feature set; nothing references it in the
// wasm/ffi builds, so it links away. See docs/cloud-storage-backups.md.
pub mod sigv4;
// Build-time feature flags, generated from packages/core/src/flags.json (one source shared with TS).
mod flags;
// Sync handshake/nostr compile into every layer: device sync must run natively so it
// works under Lockdown Mode (no WASM). Each module carries a wasm + an ffi binding; the
// desktop build takes them bare via `native` (which `ffi` implies).
// `handshake` is public because the desktop shell links this crate as an ordinary cargo
// dependency and calls it as Rust, with no binding layer in between: the extension pairing
// reuses these exact patterns (XXpsk3 to pair, KK once both statics are known). wasm and ffi
// consumers still go through their generated bindings and are unaffected.
#[cfg(any(feature = "wasm", feature = "native"))]
pub mod handshake;
// Public for the same reason as `handshake`: the desktop shell links this crate as an
// ordinary dependency and re-exposes these to its webview as commands, because its sync host
// runs in the webview (which has WebRTC) while the crypto stays in this process.
#[cfg(any(feature = "wasm", feature = "native"))]
pub mod nostr;
// Native WebRTC data channel: iOS only (its WKWebView on capacitor:// has no
// RTCPeerConnection). Pure-Rust webrtc-rs behind uniffi; gated by `webrtc` (which
// implies ffi). Excluded from the wasm build (webrtc-rs won't target wasm32) and the
// Android build (its WebView has WebRTC). See docs/p2p-sync.md.
#[cfg(feature = "webrtc")]
mod webrtc;

// The two binding layers are mutually exclusive: each owns the bare public names
// (`generate_vek`, ...), so enabling both would collide. wasm-pack uses `wasm`; the
// native build uses `--no-default-features --features ffi`.
// Widened from wasm+ffi to wasm+native: `ffi` implies `native`, so this still catches the
// original pair, and it now also catches wasm+native, where the bare exports the desktop uses
// would collide with the wasm ones under the same names.
#[cfg(all(feature = "wasm", feature = "native"))]
compile_error!("vault-crypto: enable either `wasm` or `native`/`ffi`, not both");

#[cfg(feature = "ffi")]
uniffi::setup_scaffolding!();

const ARGON2_TIME: u32 = 3;
const ARGON2_MEM_KIB: u32 = 64 * 1024;
const ARGON2_PARALLELISM: u32 = 1;
const KEY_LEN: usize = 32;
const DEK_LEN: usize = 32;
const IV_LEN: usize = 12;
const SALT_LEN: usize = 16;
const SLOT_ID_LEN: usize = 16;

/// Framework-agnostic error for the crypto core. Each binding layer maps it to its
/// host's native error (a JS `Error` under wasm, a Swift/Kotlin exception under ffi).
#[derive(Debug)]
#[cfg_attr(feature = "ffi", derive(uniffi::Error))]
pub enum CryptoError {
    // Field is `msg`, not `message`: uniffi maps an Error variant onto Kotlin's
    // `Throwable`, and a field named `message` collides with `Throwable.message`
    // (the generated glue then fails to compile). Display is field-name-agnostic,
    // so the wasm JS error string and the Swift positional match are unaffected.
    Crypto { msg: String },
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CryptoError::Crypto { msg } => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for CryptoError {}

// wasm-bindgen throws any `Err: Into<JsValue>`; route through `JsError` so the JS side
// still receives a real `Error` object (not a bare string), preserving prior behavior.
#[cfg(feature = "wasm")]
impl From<CryptoError> for JsValue {
    fn from(e: CryptoError) -> JsValue {
        JsError::new(&e.to_string()).into()
    }
}

/// In-memory slot holding the Vault Encryption Key (VEK). Every key-slot wraps a
/// copy of the VEK; unlocking unwraps it and loads it here.
fn vek_slot() -> &'static Mutex<Option<Zeroizing<[u8; KEY_LEN]>>> {
    static SLOT: OnceLock<Mutex<Option<Zeroizing<[u8; KEY_LEN]>>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn err(msg: impl Into<String>) -> CryptoError {
    CryptoError::Crypto { msg: msg.into() }
}

fn random_bytes(buf: &mut [u8]) -> Result<(), CryptoError> {
    getrandom::getrandom(buf).map_err(|e| err(format!("rng: {e}")))
}

fn b64_decode(s: &str) -> Result<Vec<u8>, CryptoError> {
    B64.decode(s.as_bytes()).map_err(|e| err(format!("base64: {e}")))
}

fn iv_from(bytes: Vec<u8>) -> Result<[u8; IV_LEN], CryptoError> {
    bytes.try_into().map_err(|_| err("iv must be 12 bytes"))
}

/// Derive a 32-byte KEK from a password and salt via Argon2id.
fn derive_kek(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; KEY_LEN]>, CryptoError> {
    let params = Params::new(ARGON2_MEM_KIB, ARGON2_TIME, ARGON2_PARALLELISM, Some(KEY_LEN))
        .map_err(|e| err(format!("argon2 params: {e}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    argon2
        .hash_password_into(password.as_bytes(), salt, out.as_mut_slice())
        .map_err(|e| err(format!("argon2 hash: {e}")))?;
    Ok(out)
}

// Names the product Bramble was called before it was renamed. DO NOT "fix" it: this is an HKDF
// domain separator, not a label. It is never displayed, logged or exported, and its only
// requirements are uniqueness and permanence. Every security-key slot ever written wrapped its
// VEK under a KEK derived with these exact bytes, so changing them changes the KEK, the verifier
// stops matching, and every enrolled authenticator stops unlocking its vault. Re-wrapping on
// unlock could migrate a single device, but slots live in the vault blob and that blob syncs, so
// a migrated vault would break security-key unlock on any device still on an older build.
const WEBAUTHN_KDF_INFO: &[u8] = b"titanpass/webauthn/v1";
/// Derive a 32-byte KEK from an authenticator hmac-secret via HKDF-SHA256,
/// domain-separated by WEBAUTHN_KDF_INFO.
fn derive_kek_hkdf(hmac_secret: &[u8]) -> Result<Zeroizing<[u8; KEY_LEN]>, CryptoError> {
    let hkdf = Hkdf::<Sha256>::new(None, hmac_secret);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    hkdf.expand(WEBAUTHN_KDF_INFO, out.as_mut_slice())
        .map_err(|e| err(format!("hkdf expand: {e}")))?;
    Ok(out)
}

fn aes_encrypt(key: &[u8], iv: &[u8; IV_LEN], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| err("key must be 32 bytes"))?
        .encrypt(Nonce::from_slice(iv), plaintext)
        .map_err(|e| err(format!("aes encrypt: {e}")))
}

fn aes_decrypt(key: &[u8], iv: &[u8; IV_LEN], ct: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| err("key must be 32 bytes"))?
        .decrypt(Nonce::from_slice(iv), ct)
        .map(Zeroizing::new)
        .map_err(|e| err(format!("aes decrypt: {e}")))
}

fn with_vek<F, R>(f: F) -> Result<R, CryptoError>
where
    F: FnOnce(&[u8]) -> Result<R, CryptoError>,
{
    let guard = vek_slot().lock().unwrap();
    let key = guard.as_ref().ok_or_else(|| err("vault is locked"))?;
    f(key.as_slice())
}

fn load_vek(bytes: &[u8]) -> Result<(), CryptoError> {
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

// Result records returned to both layers: serde-serialized to a JS value under wasm,
// returned as uniffi records (camelCased in Swift/Kotlin) under ffi.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct EncryptedPayload {
    pub ciphertext: String,
    pub iv: String,
    pub wrapped_dek: String,
    pub dek_iv: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct MasterEncrypted {
    pub iv: String,
    pub ciphertext: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct PasswordSlotBlob {
    pub verifier: String,
    pub wrap_iv: String,
    pub wrapped_vek: String,
}

// ---- core (binding-agnostic) for the struct-returning calls ----

fn wrap_vek_password_core(
    password: &str,
    salt_b64: &str,
    slot_id_b64: &str,
    magic_version: &[u8],
) -> Result<PasswordSlotBlob, CryptoError> {
    let salt = b64_decode(salt_b64)?;
    let slot_id = b64_decode(slot_id_b64)?;
    let kek = derive_kek(password, &salt)?;
    with_vek(|vek| {
        let mut wrap_iv = [0u8; IV_LEN];
        random_bytes(&mut wrap_iv)?;
        let wrapped = aes_encrypt(kek.as_slice(), &wrap_iv, vek)?;
        let verifier = compute_verifier(kek.as_slice(), magic_version, &slot_id);
        Ok(PasswordSlotBlob {
            verifier: B64.encode(&verifier),
            wrap_iv: B64.encode(wrap_iv),
            wrapped_vek: B64.encode(&wrapped),
        })
    })
}

/// A portable vault: entries sealed under a key that exists only for this file, plus the
/// password slot that unwraps it. Every field is base64, and together they are exactly what
/// the TS side needs to frame a VLT1 blob (the container format stays in one language).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct PortableVault {
    pub slot_id: String,
    pub salt: String,
    pub verifier: String,
    pub wrap_iv: String,
    pub wrapped_vek: String,
    pub entries_iv: String,
    pub entries_ciphertext: String,
}

/// Seal entries into a portable vault under a FRESH key, never the session VEK.
///
/// This is what makes an exported subset independent of the vault it came from: the file's
/// password guards a key that opens that file and nothing else. Sealing under the loaded VEK
/// would turn any exported file into a second, weaker door to the whole vault. Generating the
/// key here rather than via `generate_vek` is deliberate too, since that one *replaces* the
/// session key.
fn seal_portable_vault_core(
    entries_json: &str,
    password: &str,
    magic_version: &[u8],
) -> Result<PortableVault, CryptoError> {
    let mut file_key = Zeroizing::new([0u8; KEY_LEN]);
    random_bytes(file_key.as_mut_slice())?;
    let mut salt = [0u8; SALT_LEN];
    random_bytes(&mut salt)?;
    let mut slot_id = [0u8; SLOT_ID_LEN];
    random_bytes(&mut slot_id)?;
    let mut entries_iv = [0u8; IV_LEN];
    random_bytes(&mut entries_iv)?;
    let mut wrap_iv = [0u8; IV_LEN];
    random_bytes(&mut wrap_iv)?;

    let entries_ct = aes_encrypt(file_key.as_slice(), &entries_iv, entries_json.as_bytes())?;
    let kek = derive_kek(password, &salt)?;
    let wrapped = aes_encrypt(kek.as_slice(), &wrap_iv, file_key.as_slice())?;
    let verifier = compute_verifier(kek.as_slice(), magic_version, &slot_id);

    Ok(PortableVault {
        slot_id: B64.encode(slot_id),
        salt: B64.encode(salt),
        verifier: B64.encode(&verifier),
        wrap_iv: B64.encode(wrap_iv),
        wrapped_vek: B64.encode(&wrapped),
        entries_iv: B64.encode(entries_iv),
        entries_ciphertext: B64.encode(&entries_ct),
    })
}

/// Open a portable vault, returning its entries JSON, or `None` when the password is wrong.
/// Like the sealing side it touches no session state, so importing a file cannot disturb the
/// vault that is already unlocked.
#[allow(clippy::too_many_arguments)]
fn open_portable_vault_core(
    password: &str,
    file: &PortableVault,
    magic_version: &[u8],
) -> Result<Option<String>, CryptoError> {
    let salt = b64_decode(&file.salt)?;
    let slot_id = b64_decode(&file.slot_id)?;
    let verifier = b64_decode(&file.verifier)?;
    let kek = derive_kek(password, &salt)?;

    let computed = compute_verifier(kek.as_slice(), magic_version, &slot_id);
    if !ct_eq(&computed, &verifier) {
        return Ok(None);
    }

    let wrap_iv = iv_from(b64_decode(&file.wrap_iv)?)?;
    let wrapped = b64_decode(&file.wrapped_vek)?;
    let file_key = aes_decrypt(kek.as_slice(), &wrap_iv, &wrapped)?;

    let entries_iv = iv_from(b64_decode(&file.entries_iv)?)?;
    let entries_ct = b64_decode(&file.entries_ciphertext)?;
    let plaintext = aes_decrypt(file_key.as_slice(), &entries_iv, &entries_ct)?;
    String::from_utf8(plaintext.to_vec())
        .map(Some)
        .map_err(|e| err(format!("utf8: {e}")))
}

fn wrap_vek_webauthn_core(
    hmac_secret_b64: &str,
    slot_id_b64: &str,
    magic_version: &[u8],
) -> Result<PasswordSlotBlob, CryptoError> {
    let hmac_secret = b64_decode(hmac_secret_b64)?;
    let slot_id = b64_decode(slot_id_b64)?;
    let kek = derive_kek_hkdf(&hmac_secret)?;
    with_vek(|vek| {
        let mut wrap_iv = [0u8; IV_LEN];
        random_bytes(&mut wrap_iv)?;
        let wrapped = aes_encrypt(kek.as_slice(), &wrap_iv, vek)?;
        let verifier = compute_verifier(kek.as_slice(), magic_version, &slot_id);
        Ok(PasswordSlotBlob {
            verifier: B64.encode(&verifier),
            wrap_iv: B64.encode(wrap_iv),
            wrapped_vek: B64.encode(&wrapped),
        })
    })
}

fn encrypt_entry_core(plaintext_json: &str) -> Result<EncryptedPayload, CryptoError> {
    with_vek(|vek| {
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
    })
}

fn encrypt_with_vek_core(plaintext: &str) -> Result<MasterEncrypted, CryptoError> {
    with_vek(|vek| {
        let mut iv = [0u8; IV_LEN];
        random_bytes(&mut iv)?;
        let ct = aes_encrypt(vek, &iv, plaintext.as_bytes())?;
        Ok(MasterEncrypted {
            iv: B64.encode(iv),
            ciphertext: B64.encode(&ct),
        })
    })
}

// ---- shared exports (identical body across both layers) ----

/// Whether the vault is locked (no VEK in memory).
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn is_locked() -> bool {
    vek_slot().lock().unwrap().is_none()
}

/// Clear the VEK from memory, locking the vault.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn lock() {
    *vek_slot().lock().unwrap() = None;
}

/// Generate a fresh VEK at vault creation, load it into memory, and return it
/// base64-encoded.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn generate_vek() -> Result<String, CryptoError> {
    let mut vek = [0u8; KEY_LEN];
    random_bytes(&mut vek)?;
    let encoded = B64.encode(vek);
    load_vek(&vek)?;
    Ok(encoded)
}

/// Session resume: load a cached VEK (from session storage / the biometric cache)
/// without re-deriving from a credential.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn unlock_with_vek(vek_b64: String) -> Result<(), CryptoError> {
    let bytes = b64_decode(&vek_b64)?;
    load_vek(&bytes)
}

/// Return the in-memory VEK base64-encoded (for session caching). Errors if locked.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn export_vek() -> Result<String, CryptoError> {
    let guard = vek_slot().lock().unwrap();
    let key = guard.as_ref().ok_or_else(|| err("vault is locked"))?;
    Ok(B64.encode(key.as_slice()))
}

/// Generate a fresh VEK and replace the in-memory one (caller must re-wrap every
/// slot). Refuses to run on a locked vault to avoid dropping the old key material.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn rotate_vek() -> Result<String, CryptoError> {
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
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn generate_salt() -> Result<String, CryptoError> {
    let mut salt = [0u8; SALT_LEN];
    random_bytes(&mut salt)?;
    Ok(B64.encode(salt))
}

/// Generate a random base64 slot id.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn generate_slot_id() -> Result<String, CryptoError> {
    let mut id = [0u8; SLOT_ID_LEN];
    random_bytes(&mut id)?;
    Ok(B64.encode(id))
}

/// Verifier-only check (constant-time, no VEK unwrap): does `password` match this
/// slot's stored verifier? Works while the vault is already unlocked.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn verify_password_slot(
    password: String,
    salt_b64: String,
    slot_id_b64: String,
    verifier_b64: String,
    magic_version: Vec<u8>,
) -> Result<bool, CryptoError> {
    let salt = b64_decode(&salt_b64)?;
    let slot_id = b64_decode(&slot_id_b64)?;
    let verifier = b64_decode(&verifier_b64)?;
    let kek = derive_kek(&password, &salt)?;
    let computed = compute_verifier(kek.as_slice(), &magic_version, &slot_id);
    Ok(ct_eq(&computed, &verifier))
}

/// Full unlock: verify, then unwrap the VEK and load it into memory. Returns
/// false (without mutating state) if the verifier doesn't match.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn unwrap_vek_password(
    password: String,
    salt_b64: String,
    slot_id_b64: String,
    verifier_b64: String,
    wrap_iv_b64: String,
    wrapped_vek_b64: String,
    magic_version: Vec<u8>,
) -> Result<bool, CryptoError> {
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

/// Verifier-only check for a WebAuthn slot (constant-time, no VEK unwrap).
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn verify_webauthn_slot(
    hmac_secret_b64: String,
    slot_id_b64: String,
    verifier_b64: String,
    magic_version: Vec<u8>,
) -> Result<bool, CryptoError> {
    let hmac_secret = b64_decode(&hmac_secret_b64)?;
    let slot_id = b64_decode(&slot_id_b64)?;
    let verifier = b64_decode(&verifier_b64)?;
    let kek = derive_kek_hkdf(&hmac_secret)?;
    let computed = compute_verifier(kek.as_slice(), &magic_version, &slot_id);
    Ok(ct_eq(&computed, &verifier))
}

/// Full WebAuthn unlock: verify, then unwrap the VEK into memory. Returns false
/// (without mutating state) if the verifier doesn't match.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn unwrap_vek_webauthn(
    hmac_secret_b64: String,
    slot_id_b64: String,
    verifier_b64: String,
    wrap_iv_b64: String,
    wrapped_vek_b64: String,
    magic_version: Vec<u8>,
) -> Result<bool, CryptoError> {
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

/// Decrypt an entry: VEK unwraps the DEK, the DEK decrypts the plaintext.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn decrypt_entry(
    ciphertext: String,
    iv: String,
    wrapped_dek: String,
    dek_iv: String,
) -> Result<String, CryptoError> {
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

/// Decrypt ciphertext encrypted directly under the VEK.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn decrypt_with_vek(iv_b64: String, ciphertext_b64: String) -> Result<String, CryptoError> {
    with_vek(|vek| {
        let iv = iv_from(b64_decode(&iv_b64)?)?;
        let ct = b64_decode(&ciphertext_b64)?;
        let plaintext = aes_decrypt(vek, &iv, &ct)?;
        String::from_utf8(plaintext.to_vec()).map_err(|e| err(format!("utf8: {e}")))
    })
}

// ---- WASM binding layer ----
// The struct-returning calls serialize to a JS value; the rest are the shared
// exports above (wasm-bindgen throws `CryptoError` via its `Into<JsValue>`).
#[cfg(feature = "wasm")]
mod wasm_exports {
    use super::*;

    /// Wrap the in-memory VEK under a KEK derived from `password` + `salt`. Returns
    /// the slot's verifier, wrapIv, and wrappedVek for the vault header.
    #[wasm_bindgen]
    pub fn wrap_vek_password(
        password: String,
        salt_b64: String,
        slot_id_b64: String,
        magic_version: Vec<u8>,
    ) -> Result<JsValue, CryptoError> {
        let blob = wrap_vek_password_core(&password, &salt_b64, &slot_id_b64, &magic_version)?;
        serde_wasm_bindgen::to_value(&blob).map_err(|e| err(format!("serialize: {e}")))
    }

    /// Wrap the in-memory VEK under a KEK derived from an authenticator hmac-secret.
    #[wasm_bindgen]
    pub fn wrap_vek_webauthn(
        hmac_secret_b64: String,
        slot_id_b64: String,
        magic_version: Vec<u8>,
    ) -> Result<JsValue, CryptoError> {
        let blob = wrap_vek_webauthn_core(&hmac_secret_b64, &slot_id_b64, &magic_version)?;
        serde_wasm_bindgen::to_value(&blob).map_err(|e| err(format!("serialize: {e}")))
    }

    /// Encrypt an entry: random DEK encrypts the plaintext, VEK wraps the DEK.
    #[wasm_bindgen]
    pub fn encrypt_entry(plaintext_json: String) -> Result<JsValue, CryptoError> {
        let payload = encrypt_entry_core(&plaintext_json)?;
        serde_wasm_bindgen::to_value(&payload).map_err(|e| err(format!("serialize: {e}")))
    }

    /// Encrypt plaintext directly under the VEK (no per-item DEK).
    #[wasm_bindgen]
    pub fn encrypt_with_vek(plaintext: String) -> Result<JsValue, CryptoError> {
        let payload = encrypt_with_vek_core(&plaintext)?;
        serde_wasm_bindgen::to_value(&payload).map_err(|e| err(format!("serialize: {e}")))
    }

    /// Seal entries into a portable vault under a fresh, file-only key.
    #[wasm_bindgen]
    pub fn seal_portable_vault(
        entries_json: String,
        password: String,
        magic_version: Vec<u8>,
    ) -> Result<JsValue, CryptoError> {
        let sealed = seal_portable_vault_core(&entries_json, &password, &magic_version)?;
        serde_wasm_bindgen::to_value(&sealed).map_err(|e| err(format!("serialize: {e}")))
    }

    /// Open a portable vault. Returns the entries JSON, or null for a wrong password.
    #[wasm_bindgen]
    pub fn open_portable_vault(
        password: String,
        file: JsValue,
        magic_version: Vec<u8>,
    ) -> Result<Option<String>, CryptoError> {
        let file: PortableVault =
            serde_wasm_bindgen::from_value(file).map_err(|e| err(format!("deserialize: {e}")))?;
        open_portable_vault_core(&password, &file, &magic_version)
    }

    /// Mint a passkey (provider role) for `rp_id`. Returns credentialId, COSE public
    /// key, private key (to store in the entry), and the `none` attestation object.
    #[wasm_bindgen]
    pub fn passkey_make_credential(
        rp_id: String,
        user_verified: bool,
    ) -> Result<JsValue, CryptoError> {
        let reg = crate::passkey::passkey_make_credential_core(&rp_id, user_verified)?;
        serde_wasm_bindgen::to_value(&reg).map_err(|e| err(format!("serialize: {e}")))
    }

    /// Convert a base64 P-256 PKCS#8 key into Bramble's scalar and ES256 COSE key.
    #[wasm_bindgen]
    pub fn passkey_import_pkcs8(pkcs8_b64: String) -> Result<JsValue, CryptoError> {
        let imported = crate::passkey::passkey_import_pkcs8_core(&pkcs8_b64)?;
        serde_wasm_bindgen::to_value(&imported).map_err(|e| err(format!("serialize: {e}")))
    }

    /// Assert a stored passkey: sign authenticatorData || clientDataHash with its key.
    #[wasm_bindgen]
    pub fn passkey_get_assertion(
        rp_id: String,
        private_key_b64: String,
        client_data_hash_b64: String,
        user_verified: bool,
    ) -> Result<JsValue, CryptoError> {
        let a = crate::passkey::passkey_get_assertion_core(
            &rp_id,
            &private_key_b64,
            &client_data_hash_b64,
            user_verified,
        )?;
        serde_wasm_bindgen::to_value(&a).map_err(|e| err(format!("serialize: {e}")))
    }
}

// ---- Native binding layer (uniffi -> Swift + Kotlin; plain Rust for the desktop app) ----
// The struct-returning calls hand back the record directly (no JS-value hop), which is
// what the desktop build wants too: it links the crate as an ordinary cargo dependency
// and calls these directly, so uniffi's attribute is conditional and the bodies are
// shared rather than copied into a third block. See docs/desktop-port.md.
#[cfg(any(feature = "ffi", feature = "native"))]
pub use ffi_exports::*;

#[cfg(any(feature = "ffi", feature = "native"))]
mod ffi_exports {
    use super::*;

    /// Wrap the in-memory VEK under a KEK derived from `password` + `salt`.
    #[cfg_attr(feature = "ffi", uniffi::export)]
    pub fn wrap_vek_password(
        password: String,
        salt_b64: String,
        slot_id_b64: String,
        magic_version: Vec<u8>,
    ) -> Result<PasswordSlotBlob, CryptoError> {
        wrap_vek_password_core(&password, &salt_b64, &slot_id_b64, &magic_version)
    }

    /// Wrap the in-memory VEK under a KEK derived from an authenticator hmac-secret.
    #[cfg_attr(feature = "ffi", uniffi::export)]
    pub fn wrap_vek_webauthn(
        hmac_secret_b64: String,
        slot_id_b64: String,
        magic_version: Vec<u8>,
    ) -> Result<PasswordSlotBlob, CryptoError> {
        wrap_vek_webauthn_core(&hmac_secret_b64, &slot_id_b64, &magic_version)
    }

    /// Encrypt an entry: random DEK encrypts the plaintext, VEK wraps the DEK.
    #[cfg_attr(feature = "ffi", uniffi::export)]
    pub fn encrypt_entry(plaintext_json: String) -> Result<EncryptedPayload, CryptoError> {
        encrypt_entry_core(&plaintext_json)
    }

    /// Encrypt plaintext directly under the VEK (no per-item DEK).
    #[cfg_attr(feature = "ffi", uniffi::export)]
    pub fn encrypt_with_vek(plaintext: String) -> Result<MasterEncrypted, CryptoError> {
        encrypt_with_vek_core(&plaintext)
    }

    /// Seal entries into a portable vault under a fresh, file-only key.
    #[cfg_attr(feature = "ffi", uniffi::export)]
    pub fn seal_portable_vault(
        entries_json: String,
        password: String,
        magic_version: Vec<u8>,
    ) -> Result<PortableVault, CryptoError> {
        seal_portable_vault_core(&entries_json, &password, &magic_version)
    }

    /// Open a portable vault. Returns the entries JSON, or None for a wrong password.
    #[cfg_attr(feature = "ffi", uniffi::export)]
    pub fn open_portable_vault(
        password: String,
        file: PortableVault,
        magic_version: Vec<u8>,
    ) -> Result<Option<String>, CryptoError> {
        open_portable_vault_core(&password, &file, &magic_version)
    }

    /// Mint a passkey (provider role) for `rp_id`.
    #[cfg_attr(feature = "ffi", uniffi::export)]
    pub fn passkey_make_credential(
        rp_id: String,
        user_verified: bool,
    ) -> Result<crate::passkey::PasskeyRegistration, CryptoError> {
        crate::passkey::passkey_make_credential_core(&rp_id, user_verified)
    }

    /// Convert a standard-base64 P-256 PKCS#8 private key into stored key material.
    #[cfg_attr(feature = "ffi", uniffi::export)]
    pub fn passkey_import_pkcs8(
        pkcs8_b64: String,
    ) -> Result<crate::passkey::PasskeyImportResult, CryptoError> {
        crate::passkey::passkey_import_pkcs8_core(&pkcs8_b64)
    }

    /// Assert a stored passkey: sign authenticatorData || clientDataHash with its key.
    #[cfg_attr(feature = "ffi", uniffi::export)]
    pub fn passkey_get_assertion(
        rp_id: String,
        private_key_b64: String,
        client_data_hash_b64: String,
        user_verified: bool,
    ) -> Result<crate::passkey::PasskeyAssertion, CryptoError> {
        crate::passkey::passkey_get_assertion_core(
            &rp_id,
            &private_key_b64,
            &client_data_hash_b64,
            user_verified,
        )
    }
}

// Drive the primitives directly with known IVs/keys/salts; the global VEK slot
// makes the binding wrappers awkward to test in parallel.
#[cfg(test)]
mod tests {
    use super::*;

    // The two `*_round_trip_core` tests drive the process-global VEK slot, so they must not run
    // concurrently (cargo runs tests in parallel). Serialize them on a shared lock; `into_inner`
    // ignores poisoning so one failure doesn't cascade into a confusing second. Other tests use
    // the primitives directly and stay parallel.
    // pub(crate) so portable_vault_tests can serialize against the same slot; a second
    // lock would let the two modules race each other on the one global VEK.
    pub(crate) static VEK_SLOT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
    // because `aes_decrypt` returns CryptoError, not constructable off the binding.
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

    // Vault-crypto round-trip through the core: encrypt under the VEK then decrypt.
    // Exercises the shared core used by both binding layers.
    #[test]
    fn vek_encrypt_decrypt_round_trip_core() {
        let _guard = VEK_SLOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let vek = B64.encode([0x5au8; KEY_LEN]);
        unlock_with_vek(vek).unwrap();
        let plaintext = "{\"u\":\"alice\",\"p\":\"hunter2\"}";
        let enc = encrypt_with_vek_core(plaintext).unwrap();
        let back = decrypt_with_vek(enc.iv, enc.ciphertext).unwrap();
        assert_eq!(back, plaintext);
        lock();
        assert!(is_locked());
    }

    // Entry-level (per-item DEK) round-trip through the shared core.
    #[test]
    fn entry_encrypt_decrypt_round_trip_core() {
        let _guard = VEK_SLOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        unlock_with_vek(B64.encode([0x11u8; KEY_LEN])).unwrap();
        let json = "{\"title\":\"GitHub\"}";
        let p = encrypt_entry_core(json).unwrap();
        let back = decrypt_entry(p.ciphertext, p.iv, p.wrapped_dek, p.dek_iv).unwrap();
        assert_eq!(back, json);
        lock();
    }
}

// A portable vault is the "export these entries to a file" format. Its whole point is that
// the file's key is not the vault's key, so these tests pin that property alongside the
// round trip: sealing must never read or write the session VEK slot.
#[cfg(test)]
mod portable_vault_tests {
    use super::*;
    use crate::tests::VEK_SLOT_LOCK;

    const MAGIC: &[u8] = b"VLT1";
    const ENTRIES: &str = r#"{"entries":[{"id":"a","passkeys":[{"rpId":"github.com"}]}]}"#;

    fn seal(password: &str) -> PortableVault {
        seal_portable_vault_core(ENTRIES, password, MAGIC).expect("seal")
    }

    #[test]
    fn round_trips_the_entries_json_verbatim() {
        let file = seal("file-password");
        let opened = open_portable_vault_core("file-password", &file, MAGIC).expect("open");
        assert_eq!(opened.as_deref(), Some(ENTRIES));
    }

    // Passkeys are the reason this format exists rather than reusing the KDBX export, which
    // cannot represent them at all.
    #[test]
    fn carries_nested_passkey_material_through() {
        let file = seal("pw");
        let opened = open_portable_vault_core("pw", &file, MAGIC)
            .expect("open")
            .expect("right password");
        assert!(opened.contains("\"rpId\":\"github.com\""));
    }

    #[test]
    fn rejects_a_wrong_password_without_erroring() {
        let file = seal("right");
        let opened = open_portable_vault_core("wrong", &file, MAGIC).expect("open");
        assert_eq!(opened, None);
    }

    // A verifier is computed over the magic version, so a file from a future format cannot be
    // silently opened by an older reader.
    #[test]
    fn rejects_a_different_magic_version() {
        let file = seal("pw");
        let opened = open_portable_vault_core("pw", &file, b"VLT9").expect("open");
        assert_eq!(opened, None);
    }

    // The salt, slot id and both IVs are per-file, so the same entries under the same password
    // must never produce identical ciphertext.
    #[test]
    fn seals_with_fresh_randomness_each_time() {
        let a = seal("same");
        let b = seal("same");
        assert_ne!(a.entries_ciphertext, b.entries_ciphertext);
        assert_ne!(a.wrapped_vek, b.wrapped_vek);
        assert_ne!(a.salt, b.salt);
        assert_ne!(a.slot_id, b.slot_id);
    }

    // The property the whole design rests on: cracking an exported file's password must not
    // yield the key to the live vault. Sealing runs with a vault unlocked and must neither read
    // that VEK nor leave it changed.
    #[test]
    fn never_touches_the_session_vek() {
        let _guard = VEK_SLOT_LOCK.lock();
        let vault_vek = generate_vek().expect("load a session VEK");

        let file = seal("file-password");

        assert_eq!(export_vek().expect("still unlocked"), vault_vek);
        let opened = open_portable_vault_core("file-password", &file, MAGIC).expect("open");
        assert_eq!(opened.as_deref(), Some(ENTRIES));
        assert_eq!(export_vek().expect("still unlocked"), vault_vek);
        lock();
    }

    // Sealing must work on a LOCKED vault too. Nothing about producing a file depends on a
    // session key, and a caller that got this wrong would fail only for locked users.
    #[test]
    fn works_while_the_vault_is_locked() {
        let _guard = VEK_SLOT_LOCK.lock();
        lock();
        let file = seal("pw");
        assert!(is_locked());
        let opened = open_portable_vault_core("pw", &file, MAGIC).expect("open");
        assert_eq!(opened.as_deref(), Some(ENTRIES));
        assert!(is_locked());
    }
}
