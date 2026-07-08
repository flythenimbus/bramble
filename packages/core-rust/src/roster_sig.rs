//! Ed25519 device-key signing for the sync roster (Item A: authenticated roster mutations).
//!
//! Each device holds an Ed25519 keypair generated at enrollment and stored locally. Its verify
//! key (`sigKey`) plus a signature (`sig`) over the entry's canonical form bind the roster
//! entry's id <-> keys <-> stamp, so a compromised member cannot impersonate another device or
//! resurrect a revoked one. The TS side builds the canonical bytes (`canonicalRosterEntry`); this
//! module holds the key and signs/verifies those bytes. See docs/p2p-sync-revocation-hardening.md.
//!
//! Core functions work on raw bytes (native-testable); the `#[wasm_bindgen]` / uniffi exports are
//! thin wrappers. The secret is the 32-byte Ed25519 seed; `from_bytes` reconstructs the key
//! deterministically, so storing the seed is sufficient.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::Serialize;

use crate::CryptoError;
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

// ---- core (native-testable, no JS types) ----

fn generate() -> Result<([u8; 32], [u8; 32]), String> {
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).map_err(|e| format!("rng: {e}"))?;
    let sk = SigningKey::from_bytes(&seed);
    Ok((seed, sk.verifying_key().to_bytes()))
}

fn public_from_secret(secret: &[u8]) -> Result<[u8; 32], String> {
    let seed: [u8; 32] = secret.try_into().map_err(|_| "secret must be 32 bytes".to_string())?;
    Ok(SigningKey::from_bytes(&seed).verifying_key().to_bytes())
}

fn sign(secret: &[u8], msg: &[u8]) -> Result<[u8; 64], String> {
    let seed: [u8; 32] = secret.try_into().map_err(|_| "secret must be 32 bytes".to_string())?;
    Ok(SigningKey::from_bytes(&seed).sign(msg).to_bytes())
}

fn verify(pubkey: &[u8], msg: &[u8], sig: &[u8]) -> Result<bool, String> {
    // Fail closed (Ok(false)) on any malformed input; never panic on a wrong-length slice.
    let pk: [u8; 32] = match pubkey.try_into() {
        Ok(p) => p,
        Err(_) => return Ok(false),
    };
    let vk = match VerifyingKey::from_bytes(&pk) {
        Ok(v) => v,
        Err(_) => return Ok(false),
    };
    let sig: [u8; 64] = match sig.try_into() {
        Ok(s) => s,
        Err(_) => return Ok(false),
    };
    Ok(vk.verify(msg, &Signature::from_bytes(&sig)).is_ok())
}

// ---- binding layers: serde -> JsValue under wasm, uniffi under ffi ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct RosterKey {
    pub secret_key: String,
    pub public_key: String,
}

fn ce(msg: String) -> CryptoError {
    CryptoError::Crypto { msg }
}

fn b64dec(s: &str) -> Result<Vec<u8>, CryptoError> {
    B64.decode(s.as_bytes()).map_err(|e| ce(format!("base64: {e}")))
}

fn generate_key_core() -> Result<RosterKey, CryptoError> {
    let (secret, public) = generate().map_err(ce)?;
    Ok(RosterKey {
        secret_key: B64.encode(secret),
        public_key: B64.encode(public),
    })
}

/// The Ed25519 verify key for a secret seed, base64.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn roster_sig_public_key(secret_b64: String) -> Result<String, CryptoError> {
    Ok(B64.encode(public_from_secret(&b64dec(&secret_b64)?).map_err(ce)?))
}

/// Ed25519-sign the canonical roster-entry string (its UTF-8 bytes). Base64 secret in, base64
/// 64-byte signature out. `message` is `canonicalRosterEntry(entry)` verbatim.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn roster_sign(secret_b64: String, message: String) -> Result<String, CryptoError> {
    let sig = sign(&b64dec(&secret_b64)?, message.as_bytes()).map_err(ce)?;
    Ok(B64.encode(sig))
}

/// Verify an Ed25519 signature over the canonical roster-entry string.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn roster_verify(
    public_b64: String,
    message: String,
    sig_b64: String,
) -> Result<bool, CryptoError> {
    verify(&b64dec(&public_b64)?, message.as_bytes(), &b64dec(&sig_b64)?).map_err(ce)
}

/// Generate an Ed25519 device keypair. Returns base64 secret seed + verify key.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn roster_sig_generate_key() -> Result<JsValue, CryptoError> {
    serde_wasm_bindgen::to_value(&generate_key_core()?).map_err(|e| ce(format!("serialize: {e}")))
}

#[cfg(feature = "ffi")]
#[uniffi::export]
pub fn roster_sig_generate_key() -> Result<RosterKey, CryptoError> {
    generate_key_core()
}

#[cfg(test)]
mod tests {
    use super::{generate, public_from_secret, sign, verify};

    #[test]
    fn sign_then_verify_round_trip() {
        let (secret, public) = generate().unwrap();
        let msg = br#"["laptop","pk","sk",1,2,0,"laptop"]"#;
        let sig = sign(&secret, msg).unwrap();
        assert!(verify(&public, msg, &sig).unwrap());
    }

    #[test]
    fn public_key_is_derivable_from_secret() {
        let (secret, public) = generate().unwrap();
        assert_eq!(public_from_secret(&secret).unwrap(), public);
    }

    #[test]
    fn wrong_key_does_not_verify() {
        let (secret, _public) = generate().unwrap();
        let (_other_secret, other_public) = generate().unwrap();
        let sig = sign(&secret, b"m").unwrap();
        assert!(!verify(&other_public, b"m", &sig).unwrap());
    }

    #[test]
    fn tampered_message_does_not_verify() {
        let (secret, public) = generate().unwrap();
        let sig = sign(&secret, b"original").unwrap();
        assert!(!verify(&public, b"tampered", &sig).unwrap());
    }

    #[test]
    fn malformed_inputs_return_false_not_panic() {
        let (_secret, public) = generate().unwrap();
        assert!(!verify(&public, b"m", &[0u8; 10]).unwrap()); // bad sig length
        assert!(!verify(&[0u8; 5], b"m", &[0u8; 64]).unwrap()); // bad pubkey length
    }
}
