//! Mailbox keys and sealing (docs/mailbox-service.md, "Keys and identity").
//!
//! Both keys come from the VEK, salted with the sync group's key: a pairing code carries the group
//! key, so nothing here derives from it alone, and a group formed again (a restore, a re-pair) gets
//! a new mailbox. The VEK never leaves this crate; callers see the id, sealed bytes and plaintext.
//!
//! Sealed format v1: `0x01 || nonce (12) || AES-256-GCM(seal key, nonce, plaintext, aad)`.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{
    engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD},
    Engine,
};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::CryptoError;
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

const ID_INFO: &[u8] = b"bramble/mailbox/v1/id";
const SEAL_INFO: &[u8] = b"bramble/mailbox/v1/seal";
const VERSION: u8 = 1;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const GROUP_KEY_LEN: usize = 32;

fn derive_key(
    vek: &[u8],
    group_key: &[u8],
    info: &[u8],
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let mut out = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(group_key), vek)
        .expand(info, out.as_mut_slice())
        .map_err(|e| super::err(format!("hkdf expand: {e}")))?;
    Ok(out)
}

fn group_key(b64: &str) -> Result<Vec<u8>, CryptoError> {
    let bytes = super::b64_decode(b64)?;
    if bytes.len() != GROUP_KEY_LEN {
        return Err(super::err("group key must be 32 bytes"));
    }
    Ok(bytes)
}

fn seal(key: &[u8], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let mut nonce = [0u8; NONCE_LEN];
    super::random_bytes(&mut nonce)?;
    let ct = Aes256Gcm::new_from_slice(key)
        .map_err(|_| super::err("key must be 32 bytes"))?
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|e| super::err(format!("aes encrypt: {e}")))?;
    let mut out = Vec::with_capacity(1 + NONCE_LEN + ct.len());
    out.push(VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

fn open(key: &[u8], aad: &[u8], sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if sealed.len() < 1 + NONCE_LEN + TAG_LEN || sealed[0] != VERSION {
        return Err(super::err("not a sealed mailbox message"));
    }
    let (nonce, ct) = sealed[1..].split_at(NONCE_LEN);
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| super::err("key must be 32 bytes"))?
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad })
        .map(Zeroizing::new)
        .map_err(|_| super::err("mailbox open failed"))
}

/// The group's mailbox id: 32 bytes from the VEK salted by the group key, base64url unpadded.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn mailbox_id(group_key_b64: String) -> Result<String, CryptoError> {
    let group = group_key(&group_key_b64)?;
    super::with_vek(|vek| Ok(URL_SAFE_NO_PAD.encode(derive_key(vek, &group, ID_INFO)?.as_slice())))
}

/// Seal `plaintext` for the group's mailbox, binding `aad`. Base64 out.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn mailbox_seal(
    group_key_b64: String,
    aad: String,
    plaintext: String,
) -> Result<String, CryptoError> {
    let group = group_key(&group_key_b64)?;
    super::with_vek(|vek| {
        let key = derive_key(vek, &group, SEAL_INFO)?;
        Ok(B64.encode(seal(key.as_slice(), aad.as_bytes(), plaintext.as_bytes())?))
    })
}

/// Open a sealed message with the same `aad`; any mismatch or tampering is "mailbox open failed".
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn mailbox_open(
    group_key_b64: String,
    aad: String,
    sealed_b64: String,
) -> Result<String, CryptoError> {
    let group = group_key(&group_key_b64)?;
    let sealed = super::b64_decode(&sealed_b64)?;
    super::with_vek(|vek| {
        let key = derive_key(vek, &group, SEAL_INFO)?;
        let plain = open(key.as_slice(), aad.as_bytes(), &sealed)?;
        String::from_utf8(plain.to_vec()).map_err(|_| super::err("plaintext is not utf-8"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::VEK_SLOT_LOCK;
    use crate::CryptoError;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};

    const VEK_A: [u8; 32] = [0x11; 32];
    const VEK_B: [u8; 32] = [0x22; 32];

    fn group(byte: u8) -> String {
        B64.encode([byte; 32])
    }

    fn load(vek: [u8; 32]) {
        crate::unlock_with_vek(B64.encode(vek)).unwrap();
    }

    fn msg<T: std::fmt::Debug>(r: Result<T, CryptoError>) -> String {
        match r.unwrap_err() {
            CryptoError::Crypto { msg } => msg,
        }
    }

    fn held() -> std::sync::MutexGuard<'static, ()> {
        VEK_SLOT_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn the_id_is_43_base64url_chars_and_deterministic() {
        let _g = held();
        load(VEK_A);
        let id = mailbox_id(group(1)).unwrap();
        assert_eq!(id.len(), 43);
        assert!(id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_eq!(id, mailbox_id(group(1)).unwrap());
    }

    #[test]
    fn the_id_differs_by_group_key_and_by_vault_key() {
        let _g = held();
        load(VEK_A);
        let a1 = mailbox_id(group(1)).unwrap();
        assert_ne!(a1, mailbox_id(group(2)).unwrap());
        load(VEK_B);
        assert_ne!(a1, mailbox_id(group(1)).unwrap());
    }

    #[test]
    fn the_id_and_the_seal_key_are_different_derivations() {
        let id = derive_key(&VEK_A, &[1u8; 32], ID_INFO).unwrap();
        let seal = derive_key(&VEK_A, &[1u8; 32], SEAL_INFO).unwrap();
        assert_ne!(id.as_slice(), seal.as_slice());
    }

    #[test]
    fn sealing_round_trips_and_binds_the_aad() {
        let _g = held();
        load(VEK_A);
        let sealed = mailbox_seal(group(1), "aad".into(), "hello".into()).unwrap();
        assert_eq!(
            mailbox_open(group(1), "aad".into(), sealed.clone()).unwrap(),
            "hello"
        );
        assert_eq!(
            msg(mailbox_open(group(1), "other".into(), sealed)),
            "mailbox open failed"
        );
    }

    #[test]
    fn opening_under_another_group_key_fails() {
        let _g = held();
        load(VEK_A);
        let sealed = mailbox_seal(group(1), "aad".into(), "hello".into()).unwrap();
        assert_eq!(
            msg(mailbox_open(group(2), "aad".into(), sealed)),
            "mailbox open failed"
        );
    }

    #[test]
    fn a_flipped_byte_or_an_unknown_version_is_refused() {
        let _g = held();
        load(VEK_A);
        let sealed = B64
            .decode(mailbox_seal(group(1), "aad".into(), "hello".into()).unwrap())
            .unwrap();
        let open = |bytes: &[u8]| mailbox_open(group(1), "aad".into(), B64.encode(bytes));

        let mut flipped = sealed.clone();
        *flipped.last_mut().unwrap() ^= 1;
        assert_eq!(msg(open(&flipped)), "mailbox open failed");

        let mut versioned = sealed.clone();
        versioned[0] = 2;
        assert_eq!(msg(open(&versioned)), "not a sealed mailbox message");
        assert_eq!(msg(open(&sealed[..12])), "not a sealed mailbox message");
    }

    #[test]
    fn two_seals_of_the_same_plaintext_differ() {
        let _g = held();
        load(VEK_A);
        let one = mailbox_seal(group(1), "aad".into(), "same".into()).unwrap();
        let two = mailbox_seal(group(1), "aad".into(), "same".into()).unwrap();
        assert_ne!(one, two);
    }

    #[test]
    fn a_1_mib_plaintext_round_trips() {
        let _g = held();
        load(VEK_A);
        let big = "x".repeat(1 << 20);
        let sealed = mailbox_seal(group(1), "aad".into(), big.clone()).unwrap();
        assert_eq!(mailbox_open(group(1), "aad".into(), sealed).unwrap(), big);
    }

    #[test]
    fn a_bad_group_key_is_an_error_not_a_panic() {
        let _g = held();
        load(VEK_A);
        assert!(mailbox_id("!!not base64!!".into()).is_err());
        assert_eq!(
            msg(mailbox_id(B64.encode([1u8; 16]))),
            "group key must be 32 bytes"
        );
        assert_eq!(
            msg(mailbox_seal(
                B64.encode([1u8; 33]),
                "aad".into(),
                "x".into()
            )),
            "group key must be 32 bytes"
        );
    }

    #[test]
    fn everything_refuses_a_locked_vault() {
        let _g = held();
        load(VEK_A);
        let sealed = mailbox_seal(group(1), "aad".into(), "hello".into()).unwrap();
        crate::lock();
        assert_eq!(msg(mailbox_id(group(1))), "vault is locked");
        assert_eq!(
            msg(mailbox_seal(group(1), "aad".into(), "x".into())),
            "vault is locked"
        );
        assert_eq!(
            msg(mailbox_open(group(1), "aad".into(), sealed)),
            "vault is locked"
        );
    }
}
