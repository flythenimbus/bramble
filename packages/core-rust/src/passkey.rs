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
use p256::pkcs8::EncodePublicKey;
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

/// Result of asserting a passkey. The caller supplies credentialId + userHandle to
/// the OS; these two fields are the parts that require the private key.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct PasskeyAssertion {
    /// base64 authenticatorData (37 bytes: rpIdHash || flags || signCount=0).
    pub authenticator_data: String,
    /// base64 ASN.1 DER ECDSA signature over authenticatorData || clientDataHash.
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

/// Mint a new passkey for `rp_id`. ES256 (COSE -7) only for now.
pub fn passkey_make_credential_core(
    rp_id: &str,
    user_verified: bool,
) -> Result<PasskeyRegistration, CryptoError> {
    let secret = generate_p256()?;
    let public = secret.public_key();
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

    let cose = CoseKeyBuilder::new_ec2_pub_key(iana::EllipticCurve::P_256, x, y)
        .algorithm(iana::Algorithm::ES256)
        .build();
    let cose_bytes = cose
        .to_vec()
        .map_err(|e| err(format!("cose encode: {e}")))?;

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
        private_key: B64.encode(secret.to_bytes()),
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
pub fn passkey_get_assertion_core(
    rp_id: &str,
    private_key_b64: &str,
    client_data_hash_b64: &str,
    user_verified: bool,
) -> Result<PasskeyAssertion, CryptoError> {
    let priv_bytes = Zeroizing::new(b64_decode(private_key_b64)?);
    let client_data_hash = b64_decode(client_data_hash_b64)?;
    let secret =
        p256::SecretKey::from_slice(&priv_bytes).map_err(|_| err("invalid passkey private key"))?;
    let signing_key = SigningKey::from(&secret);

    let flags = FLAG_UP | FLAG_SYNCED | if user_verified { FLAG_UV } else { 0 };
    let auth_data = authenticator_data(rp_id, flags, None);

    let mut message = auth_data.clone();
    message.extend_from_slice(&client_data_hash);
    let signature: Signature = signing_key
        .try_sign(&message)
        .map_err(|e| err(format!("ecdsa sign: {e}")))?;

    Ok(PasskeyAssertion {
        authenticator_data: B64.encode(&auth_data),
        signature: B64.encode(signature.to_der().to_bytes()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Verifier, VerifyingKey};

    fn verifying_key(private_key_b64: &str) -> VerifyingKey {
        let bytes = B64.decode(private_key_b64).unwrap();
        let secret = p256::SecretKey::from_slice(&bytes).unwrap();
        VerifyingKey::from(SigningKey::from(&secret))
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
            passkey_get_assertion_core(rp, &reg.private_key, &client_data_hash, true).unwrap();

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
            passkey_get_assertion_core(rp, &reg.private_key, &B64.encode([0x01u8; 32]), false)
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
