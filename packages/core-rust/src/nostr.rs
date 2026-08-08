//! Nostr event signing (BIP340 schnorr over secp256k1) for sync signaling.
//!
//! Signaling rides public Nostr relays, which validate event signatures, so the
//! client must sign properly. The TS codec builds the event and computes its id
//! (sha256 of the NIP-01 serialization); this module holds the secp256k1 key and
//! signs/verifies that 32-byte id. The key is ephemeral per group, derived from
//! the group secret, so it is unlinkable across groups. See docs/p2p-sync.md.
//!
//! Core functions work on raw bytes (native-testable); the `#[wasm_bindgen]`
//! exports are thin base64 wrappers.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use k256::schnorr::{
    signature::{Signer, Verifier},
    Signature, SigningKey, VerifyingKey,
};
use serde::Serialize;

use crate::CryptoError;
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

// ---- core (native-testable, no JS types) ----

fn generate() -> Result<([u8; 32], [u8; 32]), String> {
    let mut secret = [0u8; 32];
    getrandom::getrandom(&mut secret).map_err(|e| format!("rng: {e}"))?;
    let sk = SigningKey::from_bytes(&secret).map_err(|e| format!("key: {e}"))?;
    let pubkey: [u8; 32] = sk.verifying_key().to_bytes().into();
    Ok((secret, pubkey))
}

fn public_from_secret(secret: &[u8]) -> Result<[u8; 32], String> {
    let sk = SigningKey::from_bytes(secret).map_err(|e| format!("key: {e}"))?;
    Ok(sk.verifying_key().to_bytes().into())
}

fn sign(secret: &[u8], msg: &[u8]) -> Result<[u8; 64], String> {
    let sk = SigningKey::from_bytes(secret).map_err(|e| format!("key: {e}"))?;
    let sig: Signature = sk.try_sign(msg).map_err(|e| format!("sign: {e}"))?;
    Ok(sig.to_bytes())
}

fn verify(pubkey: &[u8], msg: &[u8], sig: &[u8]) -> Result<bool, String> {
    let vk = VerifyingKey::from_bytes(pubkey).map_err(|e| format!("pubkey: {e}"))?;
    // k256's Signature::try_from panics on a wrong-length slice, so length-check first.
    if sig.len() != 64 {
        return Ok(false);
    }
    let sig = match Signature::try_from(sig) {
        Ok(s) => s,
        Err(_) => return Ok(false),
    };
    Ok(vk.verify(msg, &sig).is_ok())
}

// ---- binding layers: serde -> JsValue under wasm, uniffi under ffi ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct NostrKey {
    pub secret_key: String,
    pub public_key: String,
}

fn ce(msg: String) -> CryptoError {
    CryptoError::Crypto { msg }
}

fn b64dec(s: &str) -> Result<Vec<u8>, CryptoError> {
    B64.decode(s.as_bytes()).map_err(|e| ce(format!("base64: {e}")))
}

fn generate_key_core() -> Result<NostrKey, CryptoError> {
    let (secret, public) = generate().map_err(ce)?;
    Ok(NostrKey {
        secret_key: B64.encode(secret),
        public_key: B64.encode(public),
    })
}

/// The x-only public key for a secret key, base64.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn nostr_public_key(secret_b64: String) -> Result<String, CryptoError> {
    Ok(B64.encode(public_from_secret(&b64dec(&secret_b64)?).map_err(ce)?))
}

/// BIP340-sign a 32-byte event id (base64 in, base64 64-byte sig out).
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn nostr_sign(secret_b64: String, hash_b64: String) -> Result<String, CryptoError> {
    let sig = sign(&b64dec(&secret_b64)?, &b64dec(&hash_b64)?).map_err(ce)?;
    Ok(B64.encode(sig))
}

/// Verify a BIP340 signature over a 32-byte event id.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn nostr_verify(
    public_b64: String,
    hash_b64: String,
    sig_b64: String,
) -> Result<bool, CryptoError> {
    verify(&b64dec(&public_b64)?, &b64dec(&hash_b64)?, &b64dec(&sig_b64)?).map_err(ce)
}

/// Generate a Nostr secp256k1 keypair. Returns base64 secret + x-only public key.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn nostr_generate_key() -> Result<JsValue, CryptoError> {
    serde_wasm_bindgen::to_value(&generate_key_core()?).map_err(|e| ce(format!("serialize: {e}")))
}

#[cfg(any(feature = "ffi", feature = "native"))]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn nostr_generate_key() -> Result<NostrKey, CryptoError> {
    generate_key_core()
}

#[cfg(test)]
mod tests {
    use super::{generate, public_from_secret, sign, verify};

    #[test]
    fn sign_then_verify_round_trip() {
        let (secret, public) = generate().unwrap();
        let id = [7u8; 32]; // stand-in for a 32-byte event id
        let sig = sign(&secret, &id).unwrap();
        assert!(verify(&public, &id, &sig).unwrap());
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
        let id = [9u8; 32];
        let sig = sign(&secret, &id).unwrap();
        assert!(!verify(&other_public, &id, &sig).unwrap());
    }

    #[test]
    fn tampered_message_does_not_verify() {
        let (secret, public) = generate().unwrap();
        let sig = sign(&secret, &[1u8; 32]).unwrap();
        assert!(!verify(&public, &[2u8; 32], &sig).unwrap());
    }

    #[test]
    fn malformed_signature_returns_false() {
        let (_secret, public) = generate().unwrap();
        assert!(!verify(&public, &[1u8; 32], &[0u8; 10]).unwrap());
    }
}
