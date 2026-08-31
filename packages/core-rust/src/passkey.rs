//! WebAuthn passkey authenticator (provider role): mint and assert discoverable
//! credentials so other sites can sign the user in. This is the opposite of the
//! security-key *unlock* in lib.rs (which consumes an authenticator's hmac-secret);
//! here Bramble *is* the authenticator. See docs/passkey-provider.md.
//!
//! Both functions are pure and sync: keygen and signing happen here, but the
//! private key rides the caller's existing entry encryption (it is returned at
//! creation, base64'd into the entry, and handed back in for each assertion). No
//! VEK slot, no async runtime, so this compiles cleanly into both binding layers.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ciborium::Value;
use coset::{iana, CborSerializable, CoseKeyBuilder};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::pkcs8::{der::Decode, DecodePrivateKey, EncodePublicKey, PrivateKeyInfo};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{b64_decode, err, random_bytes, CryptoError};

const CREDENTIAL_ID_LEN: usize = 16;

// authenticatorData flag bits (WebAuthn L3 6.1).
const FLAG_UP: u8 = 0x01; // user present
const FLAG_UV: u8 = 0x04; // user verified
const FLAG_BE: u8 = 0x08; // backup eligible (multi-device credential)
const FLAG_BS: u8 = 0x10; // backup state (currently backed up / synced)
const FLAG_AT: u8 = 0x40; // attested credential data included

// Bramble syncs passkeys across devices (the P2P mesh), so every credential is a
// multi-device credential that is currently backed up: BE and BS are always set.
const FLAG_SYNCED: u8 = FLAG_BE | FLAG_BS;

/// Bramble's authenticator AAGUID (4249c72f-2967-4a74-8ec5-e610036d7be1), advertised in
/// attestedCredentialData so relying parties + other password managers can identify the
/// provider. Permanent and fixed across all installs: it is baked into every passkey we create,
/// so do NOT change it. TODO(passkeys): register it in the community AAGUID list so UIs can show
/// "Bramble" + icon - see docs/passkey-provider.md ("AAGUID registration").
const BRAMBLE_AAGUID: [u8; 16] = [
    0x42, 0x49, 0xc7, 0x2f, 0x29, 0x67, 0x4a, 0x74, 0x8e, 0xc5, 0xe6, 0x10, 0x03, 0x6d, 0x7b, 0xe1,
];

/// Result of minting a passkey. `private_key` is the only secret; the caller stores
/// it inside the (encrypted) entry. The rest are handed to the relying party.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct PasskeyRegistration {
    /// base64 random credential id minted here.
    pub credential_id: String,
    /// base64 COSE_Key public key the RP verifies against.
    pub public_key_cose: String,
    /// base64 raw P-256 private scalar (32 bytes). Store inside the entry.
    pub private_key: String,
    /// base64 CBOR attestation object (`fmt: "none"`).
    pub attestation_object: String,
    /// base64 authenticatorData (also inside the attestation object). The
    /// RegistrationResponseJSON requires it as a sibling field.
    pub authenticator_data: String,
    /// base64 SPKI DER of the public key. Chrome's webAuthenticationProxy requires
    /// RegistrationResponseJSON.response.publicKey (the spec marks it optional).
    pub public_key: String,
}

/// Bramble key material converted from a P-256 PKCS#8 key, in standard base64.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct PasskeyImportResult {
    /// base64 32-byte secret: a P-256 scalar for ES256, an Ed25519 seed for EdDSA. Which one it
    /// is cannot be told from the bytes, so `alg` below is what makes it usable.
    pub private_key: String,
    /// base64 canonical COSE_Key derived from the private key.
    pub public_key_cose: String,
    /// COSE algorithm the key belongs to, read from its PKCS#8 OID. Stored on the credential
    /// and handed back to `passkey_get_assertion_core` to pick the signer.
    pub alg: i32,
}

/// Result of asserting a passkey. The caller supplies credentialId + userHandle to
/// the OS; these two fields are the parts that require the private key.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct PasskeyAssertion {
    /// base64 authenticatorData (37 bytes: rpIdHash || flags || signCount=0).
    pub authenticator_data: String,
    /// base64 signature over authenticatorData || clientDataHash: ASN.1 DER for ES256,
    /// raw 64 bytes for EdDSA, per WebAuthn.
    pub signature: String,
}

/// rpIdHash(32) || flags(1) || signCount(4, always 0) || optional attestedCredentialData.
/// signCount stays 0: synced passkeys must not increment (a regression reads as a clone).
fn authenticator_data(rp_id: &str, flags: u8, attested: Option<&[u8]>) -> Vec<u8> {
    let rp_hash = Sha256::digest(rp_id.as_bytes());
    let mut data = Vec::with_capacity(37 + attested.map_or(0, <[u8]>::len));
    data.extend_from_slice(rp_hash.as_slice());
    data.push(flags);
    data.extend_from_slice(&[0u8; 4]);
    if let Some(att) = attested {
        data.extend_from_slice(att);
    }
    data
}

/// Generate a valid P-256 secret key from the platform RNG. `from_slice` rejects a
/// scalar outside [1, n-1]; that is astronomically rare, so a few retries suffice.
fn generate_p256() -> Result<p256::SecretKey, CryptoError> {
    for _ in 0..8 {
        let mut bytes = Zeroizing::new([0u8; 32]);
        random_bytes(bytes.as_mut_slice())?;
        if let Ok(sk) = p256::SecretKey::from_slice(bytes.as_slice()) {
            return Ok(sk);
        }
    }
    Err(err("p256 keygen: no valid scalar"))
}

/// COSE algorithm ids we can hold a key for. ES256 is the only one we MINT; Ed25519 exists
/// because KeePassXC prefers it, so an imported passkey has to be assertable.
/// See docs/passkey-import.md.
pub const COSE_ES256: i32 = -7;
pub const COSE_EDDSA: i32 = -8;

/// Keep minted and imported passkeys on one canonical ES256 COSE representation.
fn encode_public_key_cose(public: &p256::PublicKey) -> Result<Vec<u8>, CryptoError> {
    let point = public.to_encoded_point(false);
    let x = point
        .x()
        .ok_or_else(|| err("p256: missing x"))?
        .as_slice()
        .to_vec();
    let y = point
        .y()
        .ok_or_else(|| err("p256: missing y"))?
        .as_slice()
        .to_vec();

    CoseKeyBuilder::new_ec2_pub_key(iana::EllipticCurve::P_256, x, y)
        .algorithm(iana::Algorithm::ES256)
        .build()
        .to_vec()
        .map_err(|e| err(format!("cose encode: {e}")))
}

/// COSE_Key for an Ed25519 public key: {1: OKP, 3: EdDSA, -1: Ed25519, -2: x}. coset writes
/// params in insertion order after kty/alg, so Crv then X gives the canonical CTAP2 map.
fn encode_ed25519_cose(public: &[u8; 32]) -> Result<Vec<u8>, CryptoError> {
    CoseKeyBuilder::new_okp_key()
        .algorithm(iana::Algorithm::EdDSA)
        .param(
            iana::OkpKeyParameter::Crv as i64,
            Value::from(iana::EllipticCurve::Ed25519 as u64),
        )
        .param(iana::OkpKeyParameter::X as i64, Value::Bytes(public.to_vec()))
        .build()
        .to_vec()
        .map_err(|e| err(format!("cose encode: {e}")))
}

/// Convert a base64 PKCS#8 key into Bramble's stored form: a 32-byte secret, a COSE public key,
/// and the COSE algorithm that secret belongs to.
///
/// The algorithm comes from the key's own OID and nothing else. Both stored secrets are 32 bytes
/// (a P-256 scalar and an Ed25519 seed are indistinguishable), so trusting a caller-declared
/// algorithm would be a way to make us sign with the wrong primitive. Dispatching on the OID
/// rather than trying each parser in turn also stops a corrupt P-256 key surfacing as an Ed25519
/// error. See docs/passkey-import.md.
pub fn passkey_import_pkcs8_core(pkcs8_b64: &str) -> Result<PasskeyImportResult, CryptoError> {
    // Fixed message: b64_decode names the offending byte and its offset, which is key material.
    let pkcs8_der =
        Zeroizing::new(b64_decode(pkcs8_b64).map_err(|_| err("passkey key is not valid base64"))?);
    let info = PrivateKeyInfo::from_der(pkcs8_der.as_slice())
        .map_err(|_| err("passkey key is not a PKCS#8 private key"))?;

    let (private_key, public_key_cose, alg) = if info.algorithm.oid == p256::elliptic_curve::ALGORITHM_OID {
        let secret = p256::SecretKey::from_pkcs8_der(pkcs8_der.as_slice())
            .map_err(|_| err("invalid P-256 PKCS#8 private key"))?;
        let cose = encode_public_key_cose(&secret.public_key())?;
        (Zeroizing::new(secret.to_bytes().to_vec()), cose, COSE_ES256)
    } else if info.algorithm.oid == ed25519_dalek::pkcs8::ALGORITHM_OID {
        // KeypairBytes zeroizes its seed on drop, and TryFrom rejects a PKCS#8 v2 whose embedded
        // public key disagrees with the seed.
        let keypair = ed25519_dalek::pkcs8::KeypairBytes::from_pkcs8_der(pkcs8_der.as_slice())
            .map_err(|_| err("invalid Ed25519 PKCS#8 private key"))?;
        let signing = ed25519_dalek::SigningKey::try_from(&keypair)
            .map_err(|_| err("invalid Ed25519 PKCS#8 private key"))?;
        let cose = encode_ed25519_cose(&signing.verifying_key().to_bytes())?;
        (Zeroizing::new(signing.to_bytes().to_vec()), cose, COSE_EDDSA)
    } else {
        return Err(err("passkey key uses an unsupported algorithm"));
    };

    Ok(PasskeyImportResult {
        private_key: B64.encode(private_key.as_slice()),
        public_key_cose: B64.encode(public_key_cose),
        alg,
    })
}

/// Mint a new passkey for `rp_id`. ES256 (COSE -7) only for now.
pub fn passkey_make_credential_core(
    rp_id: &str,
    user_verified: bool,
) -> Result<PasskeyRegistration, CryptoError> {
    let secret = generate_p256()?;
    let public = secret.public_key();
    let cose_bytes = encode_public_key_cose(&public)?;

    let mut credential_id = [0u8; CREDENTIAL_ID_LEN];
    random_bytes(&mut credential_id)?;

    // attestedCredentialData: aaguid(16) || credIdLen(2 BE) || credId || cosePubKey.
    let mut acd = Vec::with_capacity(18 + CREDENTIAL_ID_LEN + cose_bytes.len());
    acd.extend_from_slice(&BRAMBLE_AAGUID);
    acd.extend_from_slice(&(CREDENTIAL_ID_LEN as u16).to_be_bytes());
    acd.extend_from_slice(&credential_id);
    acd.extend_from_slice(&cose_bytes);

    let flags = FLAG_UP | FLAG_AT | FLAG_SYNCED | if user_verified { FLAG_UV } else { 0 };
    let auth_data = authenticator_data(rp_id, flags, Some(&acd));
    let authenticator_data_b64 = B64.encode(&auth_data);

    // attestationObject: { fmt: "none", attStmt: {}, authData }.
    let attestation = Value::Map(vec![
        (Value::Text("fmt".into()), Value::Text("none".into())),
        (Value::Text("attStmt".into()), Value::Map(vec![])),
        (Value::Text("authData".into()), Value::Bytes(auth_data)),
    ]);
    let mut attestation_object = Vec::new();
    ciborium::into_writer(&attestation, &mut attestation_object)
        .map_err(|e| err(format!("cbor encode: {e}")))?;

    Ok(PasskeyRegistration {
        credential_id: B64.encode(credential_id),
        public_key_cose: B64.encode(&cose_bytes),
        private_key: B64.encode(Zeroizing::new(secret.to_bytes()).as_slice()),
        attestation_object: B64.encode(&attestation_object),
        authenticator_data: authenticator_data_b64,
        public_key: B64.encode(
            public
                .to_public_key_der()
                .map_err(|e| err(format!("spki encode: {e}")))?
                .as_bytes(),
        ),
    })
}

/// Assert a stored passkey: sign authenticatorData || clientDataHash with its key.
///
/// `alg` selects the primitive, because the 32-byte secret alone cannot say which it is. Unknown
/// algorithms are refused rather than defaulted: a wrong guess would produce a signature the
/// relying party rejects, which reads as "your passkey is broken" instead of "we cannot do this".
pub fn passkey_get_assertion_core(
    rp_id: &str,
    private_key_b64: &str,
    alg: i32,
    client_data_hash_b64: &str,
    user_verified: bool,
) -> Result<PasskeyAssertion, CryptoError> {
    // Fixed message, as in the import path: a decode error names an input byte.
    let priv_bytes = Zeroizing::new(
        b64_decode(private_key_b64).map_err(|_| err("invalid passkey private key"))?,
    );
    let client_data_hash = b64_decode(client_data_hash_b64)?;

    let flags = FLAG_UP | FLAG_SYNCED | if user_verified { FLAG_UV } else { 0 };
    let auth_data = authenticator_data(rp_id, flags, None);
    let mut message = auth_data.clone();
    message.extend_from_slice(&client_data_hash);

    let signature = match alg {
        COSE_ES256 => {
            let secret = p256::SecretKey::from_slice(&priv_bytes)
                .map_err(|_| err("invalid passkey private key"))?;
            let sig: Signature = SigningKey::from(&secret)
                .try_sign(&message)
                .map_err(|e| err(format!("ecdsa sign: {e}")))?;
            // WebAuthn wants ES256 signatures ASN.1 DER encoded.
            sig.to_der().to_bytes().to_vec()
        }
        COSE_EDDSA => {
            let seed: [u8; 32] = priv_bytes
                .as_slice()
                .try_into()
                .map_err(|_| err("invalid passkey private key"))?;
            let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
            // ...and EdDSA signatures raw, not DER.
            ed25519_dalek::Signer::sign(&signing, &message).to_bytes().to_vec()
        }
        _ => return Err(err("passkey uses an unsupported algorithm")),
    };

    Ok(PasskeyAssertion {
        authenticator_data: B64.encode(&auth_data),
        signature: B64.encode(signature),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use coset::{Algorithm, CoseKey, KeyType, Label};
    use p256::ecdsa::{signature::Verifier, VerifyingKey};
    // Both crates re-export the same pkcs8 trait, so one import covers to_pkcs8_der on either.
    use p256::pkcs8::EncodePrivateKey;

    fn verifying_key(private_key_b64: &str) -> VerifyingKey {
        let bytes = B64.decode(private_key_b64).unwrap();
        let secret = p256::SecretKey::from_slice(&bytes).unwrap();
        VerifyingKey::from(SigningKey::from(&secret))
    }

    #[test]
    fn import_pkcs8_derives_stored_key_material_that_can_sign() {
        let scalar = [
            0x17, 0x91, 0x22, 0x63, 0xa5, 0x11, 0xd4, 0x9e, 0x35, 0x9d, 0x1f, 0x8c, 0x88, 0x75,
            0x1a, 0xcb, 0x34, 0xfa, 0x73, 0x04, 0xea, 0x12, 0x56, 0x5d, 0xa4, 0xb3, 0xee, 0x5d,
            0x67, 0x85, 0x34, 0x12,
        ];
        let original = p256::SecretKey::from_slice(&scalar).unwrap();
        let pkcs8 = original.to_pkcs8_der().unwrap();

        let imported = passkey_import_pkcs8_core(&B64.encode(pkcs8.as_bytes())).unwrap();
        assert_eq!(B64.decode(&imported.private_key).unwrap(), scalar);

        let public_point = original.public_key().to_encoded_point(false);
        let cose = CoseKey::from_slice(&B64.decode(&imported.public_key_cose).unwrap()).unwrap();
        assert_eq!(cose.kty, KeyType::Assigned(iana::KeyType::EC2));
        assert_eq!(cose.alg, Some(Algorithm::Assigned(iana::Algorithm::ES256)));
        assert_eq!(
            cose.params,
            vec![
                (
                    Label::Int(iana::Ec2KeyParameter::Crv as i64),
                    Value::from(iana::EllipticCurve::P_256 as u64),
                ),
                (
                    Label::Int(iana::Ec2KeyParameter::X as i64),
                    Value::Bytes(public_point.x().unwrap().to_vec()),
                ),
                (
                    Label::Int(iana::Ec2KeyParameter::Y as i64),
                    Value::Bytes(public_point.y().unwrap().to_vec()),
                ),
            ]
        );

        let client_data_hash = B64.encode([0x42u8; 32]);
        let assertion = passkey_get_assertion_core(
            "import.example",
            &imported.private_key,
            COSE_ES256,
            &client_data_hash,
            true,
        )
        .unwrap();
        let mut signed = B64.decode(&assertion.authenticator_data).unwrap();
        signed.extend_from_slice(&B64.decode(client_data_hash).unwrap());
        let signature = Signature::from_der(&B64.decode(assertion.signature).unwrap()).unwrap();
        let verifying_key = VerifyingKey::from(SigningKey::from(&original));
        assert!(verifying_key.verify(&signed, &signature).is_ok());
    }

    /// A P-256 key in the encoding `crypto.subtle.exportKey("pkcs8", ...)` produces, which is
    /// what Bitwarden writes into `fido2Credentials.keyValue`. Unlike p256's own
    /// `to_pkcs8_der` (used by the test above) it carries the optional public key in the inner
    /// SEC1 structure, so the two tests cover genuinely different bytes. Pinned because #87
    /// reported every Bitwarden passkey being skipped as invalid key material.
    const WEBCRYPTO_PKCS8_B64: &str = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgBnZeheB/70OqF+B614VjAYBwjGxhQ33Dseb5CSTrH/WhRANCAAQ1mlLzgkRmXz/ixAscFjTFYAc6Jf5+f3/a1Bw2kADusY6Ss6yRf7GMpIXnAwfR9VvTe8NWEd+8epdwMks8hAVx";

    #[test]
    fn import_pkcs8_accepts_the_webcrypto_encoding_bitwarden_exports() {
        let der = B64.decode(WEBCRYPTO_PKCS8_B64).unwrap();
        let imported = passkey_import_pkcs8_core(WEBCRYPTO_PKCS8_B64).unwrap();

        // The last 64 bytes of this encoding are the uncompressed public point (x || y).
        // Comparing the re-derived COSE half against those, rather than against a key we
        // re-derived ourselves, is what catches a scalar read from the wrong field.
        let (x, y) = der[der.len() - 64..].split_at(32);
        let cose = CoseKey::from_slice(&B64.decode(&imported.public_key_cose).unwrap()).unwrap();
        assert_eq!(
            cose.params,
            vec![
                (
                    Label::Int(iana::Ec2KeyParameter::Crv as i64),
                    Value::from(iana::EllipticCurve::P_256 as u64),
                ),
                (
                    Label::Int(iana::Ec2KeyParameter::X as i64),
                    Value::Bytes(x.to_vec()),
                ),
                (
                    Label::Int(iana::Ec2KeyParameter::Y as i64),
                    Value::Bytes(y.to_vec()),
                ),
            ]
        );

        // And the stored scalar signs for that same public key.
        let client_data_hash = B64.encode([0x11u8; 32]);
        let assertion = passkey_get_assertion_core(
            "npmjs.com",
            &imported.private_key,
            COSE_ES256,
            &client_data_hash,
            true,
        )
        .unwrap();
        let mut signed = B64.decode(&assertion.authenticator_data).unwrap();
        signed.extend_from_slice(&B64.decode(client_data_hash).unwrap());
        let signature = Signature::from_der(&B64.decode(assertion.signature).unwrap()).unwrap();
        let mut point = vec![0x04];
        point.extend_from_slice(&der[der.len() - 64..]);
        let verifying_key = VerifyingKey::from_sec1_bytes(&point).unwrap();
        assert!(verifying_key.verify(&signed, &signature).is_ok());
    }

    /// An Ed25519 PKCS#8 v1 key (RFC 8410 section 7), which is what KeePassXC stores.
    const ED25519_PKCS8_V1_B64: &str =
        "MC4CAQAwBQYDK2VwBCIEIJ1S4V5N/vLBOQNDPRb+RPmBQxrTPxL3E1oGvxCkGyF3";

    fn ed25519_from_seed(seed: [u8; 32]) -> ed25519_dalek::SigningKey {
        ed25519_dalek::SigningKey::from_bytes(&seed)
    }

    #[test]
    fn import_reads_the_algorithm_from_the_key_not_from_the_caller() {
        // The whole reason `alg` exists: both stored secrets are 32 bytes, so the OID is the only
        // thing that can say which primitive owns them.
        let ed = passkey_import_pkcs8_core(ED25519_PKCS8_V1_B64).unwrap();
        assert_eq!(ed.alg, COSE_EDDSA);
        assert_eq!(B64.decode(&ed.private_key).unwrap().len(), 32);

        let p256_pkcs8 = p256::SecretKey::from_slice(&[0x11; 32])
            .unwrap()
            .to_pkcs8_der()
            .unwrap();
        let es = passkey_import_pkcs8_core(&B64.encode(p256_pkcs8.as_bytes())).unwrap();
        assert_eq!(es.alg, COSE_ES256);
    }

    #[test]
    fn ed25519_import_builds_the_canonical_okp_cose_key() {
        let imported = passkey_import_pkcs8_core(ED25519_PKCS8_V1_B64).unwrap();
        let seed: [u8; 32] = B64.decode(&imported.private_key).unwrap().try_into().unwrap();
        let expected = ed25519_from_seed(seed).verifying_key().to_bytes();

        let cose = CoseKey::from_slice(&B64.decode(&imported.public_key_cose).unwrap()).unwrap();
        assert_eq!(cose.kty, KeyType::Assigned(iana::KeyType::OKP));
        assert_eq!(cose.alg, Some(Algorithm::Assigned(iana::Algorithm::EdDSA)));
        assert_eq!(
            cose.params,
            vec![
                (
                    Label::Int(iana::OkpKeyParameter::Crv as i64),
                    Value::from(iana::EllipticCurve::Ed25519 as u64),
                ),
                (
                    Label::Int(iana::OkpKeyParameter::X as i64),
                    Value::Bytes(expected.to_vec()),
                ),
            ]
        );
    }

    #[test]
    fn ed25519_assertion_is_raw_64_bytes_and_verifies_against_the_stored_key() {
        use ed25519_dalek::Verifier;
        let imported = passkey_import_pkcs8_core(ED25519_PKCS8_V1_B64).unwrap();
        let client_data_hash = B64.encode([0x37u8; 32]);
        let assertion = passkey_get_assertion_core(
            "webauthn.io",
            &imported.private_key,
            COSE_EDDSA,
            &client_data_hash,
            true,
        )
        .unwrap();

        let sig_bytes = B64.decode(&assertion.signature).unwrap();
        // EdDSA is raw, not DER: a DER-wrapped signature is what a wrong branch would emit.
        assert_eq!(sig_bytes.len(), 64);

        let mut signed = B64.decode(&assertion.authenticator_data).unwrap();
        signed.extend_from_slice(&B64.decode(&client_data_hash).unwrap());
        let seed: [u8; 32] = B64.decode(&imported.private_key).unwrap().try_into().unwrap();
        let vk = ed25519_from_seed(seed).verifying_key();
        let sig = ed25519_dalek::Signature::from_slice(&sig_bytes).unwrap();
        assert!(vk.verify(&signed, &sig).is_ok());

        // Bound to the challenge, not just well formed.
        let other = passkey_get_assertion_core(
            "webauthn.io",
            &imported.private_key,
            COSE_EDDSA,
            &B64.encode([0x38u8; 32]),
            true,
        )
        .unwrap();
        assert_ne!(other.signature, assertion.signature);
    }

    #[test]
    fn assertion_refuses_an_algorithm_it_cannot_sign_for() {
        // No silent fallback: signing an Ed25519 seed as P-256 would emit a signature the relying
        // party rejects, which looks to a user like a corrupt passkey rather than a refusal.
        let imported = passkey_import_pkcs8_core(ED25519_PKCS8_V1_B64).unwrap();
        let hash = B64.encode([0u8; 32]);
        assert!(
            passkey_get_assertion_core("rp.example", &imported.private_key, -257, &hash, true)
                .is_err()
        );
        assert!(
            passkey_get_assertion_core("rp.example", &imported.private_key, 0, &hash, true).is_err()
        );
    }

    #[test]
    fn import_rejects_a_key_whose_embedded_public_half_disagrees_with_its_seed() {
        // PKCS#8 v2 carries the public key alongside the seed. dalek cross-checks them, so a
        // tampered pair is refused rather than silently trusted.
        let seed = [0x5au8; 32];
        let good = ed25519_from_seed(seed);
        let der = good.to_pkcs8_der().unwrap();
        let mut bytes = der.as_bytes().to_vec();
        // Flip a bit in the trailing public key, which sits at the very end of the v2 encoding.
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        assert!(passkey_import_pkcs8_core(&B64.encode(&bytes)).is_err());
        // The untampered original still imports, so the test is about the tamper, not the shape.
        assert!(passkey_import_pkcs8_core(&B64.encode(der.as_bytes())).is_ok());
    }

    #[test]
    fn import_rejects_an_algorithm_we_cannot_hold() {
        // An RSA PKCS#8 header: valid DER, unsupported OID. One fixed message, no key bytes.
        // SEQUENCE { INTEGER 0, SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }, OCTET STRING }.
        // Structurally valid so it reaches the OID check rather than failing to parse.
        let rsa = [
            0x30u8, 0x16, 0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7,
            0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, 0x04, 0x02, 0x30, 0x00,
        ];
        // let-else, not unwrap_err: these records hold key material and deliberately do not
        // derive Debug, so a panic can never print a private key.
        let Err(e) = passkey_import_pkcs8_core(&B64.encode(rsa)) else {
            panic!("an unsupported OID must not import");
        };
        assert!(format!("{e}").contains("unsupported algorithm"), "{e}");
    }

    #[test]
    fn decode_failures_never_echo_key_bytes() {
        // b64_decode names the offending byte and its offset; that byte is key material, so both
        // entry points wrap it in a fixed message.
        let bad = "AAAA!AAA";
        let Err(e) = passkey_import_pkcs8_core(bad) else {
            panic!("malformed base64 must not import");
        };
        assert_eq!(format!("{e}"), "passkey key is not valid base64");

        let Err(e2) =
            passkey_get_assertion_core("rp.example", bad, COSE_ES256, &B64.encode([0u8; 32]), true)
        else {
            panic!("malformed base64 must not assert");
        };
        assert_eq!(format!("{e2}"), "invalid passkey private key");
    }

    #[test]
    fn import_pkcs8_rejects_malformed_and_wrong_curve_keys() {
        assert!(passkey_import_pkcs8_core("not base64!").is_err());
        assert!(passkey_import_pkcs8_core(&B64.encode(b"not DER")).is_err());

        let original = p256::SecretKey::from_slice(&[0x23; 32]).unwrap();
        let pkcs8 = original.to_pkcs8_der().unwrap();
        let mut wrong_curve = pkcs8.as_bytes().to_vec();
        // id-ecPublicKey parameters: prime256v1 (1.2.840.10045.3.1.7).
        let p256_oid = [0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
        let oid_start = wrong_curve
            .windows(p256_oid.len())
            .position(|window| window == p256_oid)
            .expect("PKCS#8 contains the P-256 curve OID");
        wrong_curve[oid_start + p256_oid.len() - 1] = 0x01;
        assert!(passkey_import_pkcs8_core(&B64.encode(wrong_curve)).is_err());
    }

    // End-to-end: mint a passkey, assert with it, and verify the signature against
    // the minted public key. Catches any wiring bug in authData layout, the signed
    // message, or the DER signature encoding.
    #[test]
    fn make_then_assert_round_trip_verifies() {
        let rp = "github.com";
        let reg = passkey_make_credential_core(rp, true).unwrap();
        assert_eq!(
            B64.decode(&reg.credential_id).unwrap().len(),
            CREDENTIAL_ID_LEN
        );
        assert_eq!(
            B64.decode(&reg.attestation_object).unwrap()[0],
            0xA3,
            "CBOR map of 3"
        );

        let client_data_hash = B64.encode([0x11u8; 32]);
        let assertion =
            passkey_get_assertion_core(rp, &reg.private_key, COSE_ES256, &client_data_hash, true).unwrap();

        let auth_data = B64.decode(&assertion.authenticator_data).unwrap();
        assert_eq!(
            auth_data.len(),
            37,
            "assertion authData carries no attested data"
        );
        assert_eq!(
            &auth_data[0..32],
            Sha256::digest(rp.as_bytes()).as_slice(),
            "rpIdHash"
        );
        assert_eq!(auth_data[32], FLAG_UP | FLAG_UV | FLAG_SYNCED, "UP+UV+backup flags");
        assert_eq!(&auth_data[33..37], &[0, 0, 0, 0], "signCount must be zero");

        let mut message = auth_data.clone();
        message.extend_from_slice(&B64.decode(&client_data_hash).unwrap());
        let sig = Signature::from_der(&B64.decode(&assertion.signature).unwrap()).unwrap();
        assert!(verifying_key(&reg.private_key)
            .verify(&message, &sig)
            .is_ok());
    }

    // The signature must be bound to the exact clientDataHash (phishing/tamper guard):
    // verifying against a different challenge must fail.
    #[test]
    fn assertion_is_bound_to_client_data_hash() {
        let rp = "example.org";
        let reg = passkey_make_credential_core(rp, false).unwrap();
        let assertion =
            passkey_get_assertion_core(rp, &reg.private_key, COSE_ES256, &B64.encode([0x01u8; 32]), false)
                .unwrap();

        let auth_data = B64.decode(&assertion.authenticator_data).unwrap();
        assert_eq!(auth_data[32], FLAG_UP | FLAG_SYNCED, "UP + backup flags, no UV");

        let mut tampered = auth_data.clone();
        tampered.extend_from_slice(&[0x02u8; 32]);
        let sig = Signature::from_der(&B64.decode(&assertion.signature).unwrap()).unwrap();
        assert!(verifying_key(&reg.private_key)
            .verify(&tampered, &sig)
            .is_err());
    }

    // Registration authData embeds attested credential data with our AAGUID.
    #[test]
    fn registration_authdata_has_attested_data_and_aaguid() {
        let reg = passkey_make_credential_core("test.example", true).unwrap();
        let att: Value =
            ciborium::from_reader(B64.decode(&reg.attestation_object).unwrap().as_slice()).unwrap();
        let auth_data = match att {
            Value::Map(entries) => entries
                .into_iter()
                .find_map(|(k, v)| match (k, v) {
                    (Value::Text(t), Value::Bytes(b)) if t == "authData" => Some(b),
                    _ => None,
                })
                .expect("authData entry"),
            _ => panic!("attestationObject must be a CBOR map"),
        };
        assert_eq!(auth_data[32] & FLAG_AT, FLAG_AT, "AT flag set");
        assert_eq!(auth_data[32] & FLAG_SYNCED, FLAG_SYNCED, "synced (BE|BS) flags set");
        assert_eq!(&auth_data[37..53], &BRAMBLE_AAGUID, "aaguid present");
        let cred_len = u16::from_be_bytes([auth_data[53], auth_data[54]]) as usize;
        assert_eq!(cred_len, CREDENTIAL_ID_LEN);
        // The standalone authenticatorData field equals the bytes inside the attestation.
        assert_eq!(B64.decode(&reg.authenticator_data).unwrap(), auth_data);
    }

    // Each mint produces a fresh keypair and id.
    #[test]
    fn distinct_credentials_have_distinct_keys() {
        let a = passkey_make_credential_core("a.com", true).unwrap();
        let b = passkey_make_credential_core("a.com", true).unwrap();
        assert_ne!(a.credential_id, b.credential_id);
        assert_ne!(a.private_key, b.private_key);
    }
}
