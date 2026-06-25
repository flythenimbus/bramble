//! Roster-anchored channel auth (phase 3b): Noise_KK over the WebRTC data channel.
//!
//! Pattern: `Noise_KK_25519_ChaChaPoly_SHA256`. Each device has a static X25519
//! keypair generated at enrollment; the private key stays local (never synced),
//! the public key lives in the synced roster. KK requires each side to know the
//! peer's static public key up front, so completing the handshake is proof both
//! parties are roster members. A non-member (a relay) has no matching static key
//! and cannot complete it, which reduces the relay to an untrusted pipe even if
//! it tampers with signaling. Runs on top of the channel's DTLS as app-layer auth.
//! See docs/p2p-sync.md.
//!
//! Handshakes are stateful across messages, so sessions live in a registry keyed
//! by a u32 handle (the mesh runs several at once). The core functions work on
//! raw bytes and are unit-tested natively; the `#[wasm_bindgen]` exports are thin
//! base64/JsValue wrappers.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use snow::{params::NoiseParams, Builder, HandshakeState, TransportState};

use crate::CryptoError;
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

const NOISE_PARAMS: &str = "Noise_KK_25519_ChaChaPoly_SHA256";
// Noise caps a single message at 65535 bytes (incl. the 16-byte tag); the
// transport layer chunks anything larger.
const MAX_MSG: usize = 65535;

enum Session {
    Handshake(Box<HandshakeState>),
    Transport {
        tx: Box<TransportState>,
        // The peer's static public key, captured at completion. For KK this is
        // the (known) roster key; for enrollment XX it is the joiner's new key.
        remote_static: Vec<u8>,
    },
}

struct Registry {
    next: u32,
    sessions: HashMap<u32, Session>,
}

fn registry() -> &'static Mutex<Registry> {
    static REG: OnceLock<Mutex<Registry>> = OnceLock::new();
    REG.get_or_init(|| {
        Mutex::new(Registry {
            next: 1,
            sessions: HashMap::new(),
        })
    })
}

fn params() -> Result<NoiseParams, String> {
    NOISE_PARAMS.parse().map_err(|e| format!("noise params: {e}"))
}

fn insert_session(reg: &mut Registry, s: Session) -> u32 {
    let id = reg.next;
    reg.next = reg.next.wrapping_add(1).max(1);
    reg.sessions.insert(id, s);
    id
}

// ---- core (native-testable, no JS types) ----

fn gen_keypair() -> Result<(Vec<u8>, Vec<u8>), String> {
    let kp = Builder::new(params()?)
        .generate_keypair()
        .map_err(|e| format!("keypair: {e}"))?;
    Ok((kp.private, kp.public))
}

fn start_initiator(local_priv: &[u8], remote_pub: &[u8]) -> Result<(u32, Vec<u8>), String> {
    let mut hs = Builder::new(params()?)
        .local_private_key(local_priv)
        .remote_public_key(remote_pub)
        .build_initiator()
        .map_err(|e| format!("build initiator: {e}"))?;
    let mut buf = vec![0u8; 1024];
    let n = hs
        .write_message(&[], &mut buf)
        .map_err(|e| format!("write msg1: {e}"))?;
    let msg = buf[..n].to_vec();
    let mut reg = registry().lock().unwrap();
    let id = insert_session(&mut reg, Session::Handshake(Box::new(hs)));
    Ok((id, msg))
}

fn start_responder(local_priv: &[u8], remote_pub: &[u8]) -> Result<u32, String> {
    let hs = Builder::new(params()?)
        .local_private_key(local_priv)
        .remote_public_key(remote_pub)
        .build_responder()
        .map_err(|e| format!("build responder: {e}"))?;
    let mut reg = registry().lock().unwrap();
    Ok(insert_session(&mut reg, Session::Handshake(Box::new(hs))))
}

/// Feed an incoming handshake message; returns an optional reply to send and
/// whether the handshake is now complete (transport mode). On auth failure the
/// session is dropped (an impostor/relay gets no second chance).
fn read(session_id: u32, msg: &[u8]) -> Result<(Option<Vec<u8>>, bool), String> {
    let mut reg = registry().lock().unwrap();
    let session = reg.sessions.remove(&session_id).ok_or("unknown session")?;
    let mut hs = match session {
        Session::Handshake(hs) => hs,
        Session::Transport { tx, remote_static } => {
            reg.sessions
                .insert(session_id, Session::Transport { tx, remote_static });
            return Err("handshake already complete".into());
        }
    };
    let mut out = vec![0u8; msg.len().max(1)];
    // Failure here means the peer's static key did not match the roster key we
    // expect: leave the session removed (dropped) so it cannot be retried.
    hs.read_message(msg, &mut out)
        .map_err(|e| format!("handshake read: {e}"))?;

    // In a strict 2-party handshake, if reading did not finish it, the next
    // message is ours to send. (is_my_turn() is unreliable after the final read.)
    let mut reply = None;
    if !hs.is_handshake_finished() {
        let mut buf = vec![0u8; 1024];
        let n = hs
            .write_message(&[], &mut buf)
            .map_err(|e| format!("write reply: {e}"))?;
        reply = Some(buf[..n].to_vec());
    }
    let done = hs.is_handshake_finished();
    if done {
        let remote_static = hs.get_remote_static().map(|s| s.to_vec()).unwrap_or_default();
        let tx = hs
            .into_transport_mode()
            .map_err(|e| format!("transport: {e}"))?;
        reg.sessions.insert(
            session_id,
            Session::Transport {
                tx: Box::new(tx),
                remote_static,
            },
        );
    } else {
        reg.sessions.insert(session_id, Session::Handshake(hs));
    }
    Ok((reply, done))
}

fn encrypt(session_id: u32, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    if plaintext.len() > MAX_MSG - 16 {
        return Err("message too large for one Noise frame".into());
    }
    let mut reg = registry().lock().unwrap();
    match reg.sessions.get_mut(&session_id).ok_or("unknown session")? {
        Session::Transport { tx, .. } => {
            let mut buf = vec![0u8; plaintext.len() + 16];
            let n = tx
                .write_message(plaintext, &mut buf)
                .map_err(|e| format!("encrypt: {e}"))?;
            buf.truncate(n);
            Ok(buf)
        }
        Session::Handshake(_) => Err("handshake not complete".into()),
    }
}

fn decrypt(session_id: u32, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let mut reg = registry().lock().unwrap();
    match reg.sessions.get_mut(&session_id).ok_or("unknown session")? {
        Session::Transport { tx, .. } => {
            let mut buf = vec![0u8; ciphertext.len().max(16)];
            let n = tx
                .read_message(ciphertext, &mut buf)
                .map_err(|e| format!("decrypt: {e}"))?;
            buf.truncate(n);
            Ok(buf)
        }
        Session::Handshake(_) => Err("handshake not complete".into()),
    }
}

fn close(session_id: u32) {
    registry().lock().unwrap().sessions.remove(&session_id);
}

// ---- enrollment handshake (Noise XXpsk3) ----
//
// The joining device is not in the roster yet, so it cannot use KK. The paste
// code / QR carries a one-time 32-byte pairing secret used as the Noise PSK; XX
// transmits both static keys, so the inviter learns the joiner's key (read via
// remote_static after completion) and adds it to the roster. The group key, VEK,
// roster, and entries then flow over the established transport, never over the
// paste code.

fn enroll_params() -> Result<NoiseParams, String> {
    "Noise_XXpsk3_25519_ChaChaPoly_SHA256"
        .parse()
        .map_err(|e| format!("noise params: {e}"))
}

fn enroll_start_initiator(local_priv: &[u8], psk: &[u8]) -> Result<(u32, Vec<u8>), String> {
    let mut hs = Builder::new(enroll_params()?)
        .local_private_key(local_priv)
        .psk(3, psk)
        .build_initiator()
        .map_err(|e| format!("build enroll initiator: {e}"))?;
    let mut buf = vec![0u8; 1024];
    let n = hs
        .write_message(&[], &mut buf)
        .map_err(|e| format!("write msg1: {e}"))?;
    let msg = buf[..n].to_vec();
    let mut reg = registry().lock().unwrap();
    let id = insert_session(&mut reg, Session::Handshake(Box::new(hs)));
    Ok((id, msg))
}

fn enroll_start_responder(local_priv: &[u8], psk: &[u8]) -> Result<u32, String> {
    let hs = Builder::new(enroll_params()?)
        .local_private_key(local_priv)
        .psk(3, psk)
        .build_responder()
        .map_err(|e| format!("build enroll responder: {e}"))?;
    let mut reg = registry().lock().unwrap();
    Ok(insert_session(&mut reg, Session::Handshake(Box::new(hs))))
}

/// The peer's static public key on a completed session (KK: the known roster
/// key; enrollment XX: the joiner's newly transmitted key).
fn remote_static(session_id: u32) -> Result<Vec<u8>, String> {
    let reg = registry().lock().unwrap();
    match reg.sessions.get(&session_id).ok_or("unknown session")? {
        Session::Transport { remote_static, .. } => {
            if remote_static.is_empty() {
                Err("no remote static".into())
            } else {
                Ok(remote_static.clone())
            }
        }
        Session::Handshake(_) => Err("handshake not complete".into()),
    }
}

// ---- result records: serde -> JsValue under wasm, uniffi::Record under ffi ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct KeypairResult {
    pub private_key: String,
    pub public_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct StartResult {
    pub session_id: u32,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct ReadResult {
    pub message: Option<String>,
    pub done: bool,
}

// ---- binding-agnostic builders (base64 in/out, CryptoError) ----

fn ce(msg: String) -> CryptoError {
    CryptoError::Crypto { msg }
}

fn b64dec(s: &str) -> Result<Vec<u8>, CryptoError> {
    B64.decode(s.as_bytes()).map_err(|e| ce(format!("base64: {e}")))
}

fn generate_keypair_core() -> Result<KeypairResult, CryptoError> {
    let (private, public) = gen_keypair().map_err(ce)?;
    Ok(KeypairResult {
        private_key: B64.encode(private),
        public_key: B64.encode(public),
    })
}

fn start_initiator_core(local_priv_b64: &str, remote_pub_b64: &str) -> Result<StartResult, CryptoError> {
    let (session_id, msg) =
        start_initiator(&b64dec(local_priv_b64)?, &b64dec(remote_pub_b64)?).map_err(ce)?;
    Ok(StartResult { session_id, message: B64.encode(msg) })
}

fn enroll_initiator_core(local_priv_b64: &str, psk_b64: &str) -> Result<StartResult, CryptoError> {
    let (session_id, msg) =
        enroll_start_initiator(&b64dec(local_priv_b64)?, &b64dec(psk_b64)?).map_err(ce)?;
    Ok(StartResult { session_id, message: B64.encode(msg) })
}

fn read_core(session_id: u32, message_b64: &str) -> Result<ReadResult, CryptoError> {
    let (reply, done) = read(session_id, &b64dec(message_b64)?).map_err(ce)?;
    Ok(ReadResult { message: reply.map(|m| B64.encode(m)), done })
}

// ---- shared scalar exports (one body, both layers) ----

/// Begin a handshake as responder. Returns the session id; awaits the first message.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn handshake_start_responder(
    local_priv_b64: String,
    remote_pub_b64: String,
) -> Result<u32, CryptoError> {
    start_responder(&b64dec(&local_priv_b64)?, &b64dec(&remote_pub_b64)?).map_err(ce)
}

/// Encrypt an app message over an established session. Returns base64 ciphertext.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn handshake_encrypt(session_id: u32, plaintext: String) -> Result<String, CryptoError> {
    Ok(B64.encode(encrypt(session_id, plaintext.as_bytes()).map_err(ce)?))
}

/// Decrypt an app message over an established session. Returns the plaintext.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn handshake_decrypt(session_id: u32, ciphertext_b64: String) -> Result<String, CryptoError> {
    let pt = decrypt(session_id, &b64dec(&ciphertext_b64)?).map_err(ce)?;
    String::from_utf8(pt).map_err(|e| ce(format!("utf8: {e}")))
}

/// Begin enrollment as the inviter (responder). Returns the session id.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn handshake_enroll_responder(
    local_priv_b64: String,
    psk_b64: String,
) -> Result<u32, CryptoError> {
    enroll_start_responder(&b64dec(&local_priv_b64)?, &b64dec(&psk_b64)?).map_err(ce)
}

/// The peer's static public key on a completed session, base64. The inviter uses
/// this to add the joiner to the roster.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn handshake_remote_static(session_id: u32) -> Result<String, CryptoError> {
    Ok(B64.encode(remote_static(session_id).map_err(ce)?))
}

/// Drop a session and zero its keys.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn handshake_close(session_id: u32) {
    close(session_id);
}

// ---- struct-returning exports (same name per layer; only one compiles) ----

/// Generate a device static X25519 keypair for enrollment. The private key must be
/// stored locally only; the public key goes in the roster.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn handshake_generate_keypair() -> Result<JsValue, CryptoError> {
    serde_wasm_bindgen::to_value(&generate_keypair_core()?).map_err(|e| ce(format!("serialize: {e}")))
}

#[cfg(feature = "ffi")]
#[uniffi::export]
pub fn handshake_generate_keypair() -> Result<KeypairResult, CryptoError> {
    generate_keypair_core()
}

/// Begin a handshake as initiator. Returns the session id and the first message.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn handshake_start_initiator(
    local_priv_b64: String,
    remote_pub_b64: String,
) -> Result<JsValue, CryptoError> {
    serde_wasm_bindgen::to_value(&start_initiator_core(&local_priv_b64, &remote_pub_b64)?)
        .map_err(|e| ce(format!("serialize: {e}")))
}

#[cfg(feature = "ffi")]
#[uniffi::export]
pub fn handshake_start_initiator(
    local_priv_b64: String,
    remote_pub_b64: String,
) -> Result<StartResult, CryptoError> {
    start_initiator_core(&local_priv_b64, &remote_pub_b64)
}

/// Begin enrollment as the joiner (initiator). `psk_b64` is the pairing secret from
/// the paste code. Returns the session id and the first message.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn handshake_enroll_initiator(
    local_priv_b64: String,
    psk_b64: String,
) -> Result<JsValue, CryptoError> {
    serde_wasm_bindgen::to_value(&enroll_initiator_core(&local_priv_b64, &psk_b64)?)
        .map_err(|e| ce(format!("serialize: {e}")))
}

#[cfg(feature = "ffi")]
#[uniffi::export]
pub fn handshake_enroll_initiator(
    local_priv_b64: String,
    psk_b64: String,
) -> Result<StartResult, CryptoError> {
    enroll_initiator_core(&local_priv_b64, &psk_b64)
}

/// Feed an incoming handshake message. Returns `{ message?, done }`.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn handshake_read(session_id: u32, message_b64: String) -> Result<JsValue, CryptoError> {
    serde_wasm_bindgen::to_value(&read_core(session_id, &message_b64)?)
        .map_err(|e| ce(format!("serialize: {e}")))
}

#[cfg(feature = "ffi")]
#[uniffi::export]
pub fn handshake_read(session_id: u32, message_b64: String) -> Result<ReadResult, CryptoError> {
    read_core(session_id, &message_b64)
}

#[cfg(test)]
mod tests {
    use super::{close, decrypt, encrypt, gen_keypair, read, start_initiator, start_responder};

    #[test]
    fn kk_round_trip_then_transport() {
        let (a_priv, a_pub) = gen_keypair().unwrap();
        let (b_priv, b_pub) = gen_keypair().unwrap();

        // Each side knows the other's roster public key.
        let (init, msg1) = start_initiator(&a_priv, &b_pub).unwrap();
        let resp = start_responder(&b_priv, &a_pub).unwrap();

        // Responder consumes msg1, replies with msg2, and is done.
        let (reply, resp_done) = read(resp, &msg1).unwrap();
        let msg2 = reply.expect("responder must reply with msg2");
        assert!(resp_done);

        // Initiator consumes msg2, is done, no further reply.
        let (none, init_done) = read(init, &msg2).unwrap();
        assert!(none.is_none());
        assert!(init_done);

        // Transport works both ways.
        let ct = encrypt(init, b"sync hello").unwrap();
        assert_eq!(decrypt(resp, &ct).unwrap(), b"sync hello");
        let ct2 = encrypt(resp, b"ack").unwrap();
        assert_eq!(decrypt(init, &ct2).unwrap(), b"ack");

        close(init);
        close(resp);
    }

    #[test]
    fn impostor_key_is_rejected() {
        let (a_priv, _a_pub) = gen_keypair().unwrap();
        let (b_priv, b_pub) = gen_keypair().unwrap();
        let (_imp_priv, imp_pub) = gen_keypair().unwrap();

        // alice initiates, but the responder expects the impostor's key as peer.
        let (_init, msg1) = start_initiator(&a_priv, &b_pub).unwrap();
        let resp = start_responder(&b_priv, &imp_pub).unwrap();
        assert!(read(resp, &msg1).is_err(), "mismatched roster key must fail");
    }

    #[test]
    fn transport_before_completion_errors() {
        let (a_priv, _a_pub) = gen_keypair().unwrap();
        let (_b_priv, b_pub) = gen_keypair().unwrap();
        let (init, _msg1) = start_initiator(&a_priv, &b_pub).unwrap();
        assert!(encrypt(init, b"too soon").is_err());
        close(init);
    }

    #[test]
    fn unknown_session_errors() {
        assert!(read(999_999, b"x").is_err());
        assert!(encrypt(999_999, b"x").is_err());
        assert!(decrypt(999_999, b"x").is_err());
    }

    use super::{enroll_start_initiator, enroll_start_responder, remote_static};

    #[test]
    fn enrollment_xx_psk_exchanges_statics_and_transports() {
        let psk = [42u8; 32];
        let (inviter_priv, inviter_pub) = gen_keypair().unwrap();
        let (joiner_priv, joiner_pub) = gen_keypair().unwrap();

        // Joiner initiates; inviter responds. Both hold the one-time PSK.
        let (joiner, m1) = enroll_start_initiator(&joiner_priv, &psk).unwrap();
        let inviter = enroll_start_responder(&inviter_priv, &psk).unwrap();

        // XX is 3 messages: responder replies m2, initiator replies m3, responder done.
        let (m2, d1) = read(inviter, &m1).unwrap();
        assert!(!d1);
        let (m3, d2) = read(joiner, &m2.unwrap()).unwrap();
        assert!(d2);
        let (none, d3) = read(inviter, &m3.unwrap()).unwrap();
        assert!(none.is_none() && d3);

        // Each side learned the other's static key (the inviter adds joiner to roster).
        assert_eq!(remote_static(inviter).unwrap(), joiner_pub);
        assert_eq!(remote_static(joiner).unwrap(), inviter_pub);

        // Transport carries the VEK + roster handoff.
        let ct = encrypt(inviter, b"vek+roster+entries").unwrap();
        assert_eq!(decrypt(joiner, &ct).unwrap(), b"vek+roster+entries");
        close(joiner);
        close(inviter);
    }

    #[test]
    fn enrollment_wrong_psk_fails() {
        let (inviter_priv, _) = gen_keypair().unwrap();
        let (joiner_priv, _) = gen_keypair().unwrap();
        // PSK is mixed at message 3, so the mismatch surfaces when the inviter
        // reads the joiner's final message.
        let (joiner, m1) = enroll_start_initiator(&joiner_priv, &[1u8; 32]).unwrap();
        let inviter = enroll_start_responder(&inviter_priv, &[2u8; 32]).unwrap();
        let (m2, _) = read(inviter, &m1).unwrap();
        let (m3, _) = read(joiner, &m2.unwrap()).unwrap();
        assert!(read(inviter, &m3.unwrap()).is_err(), "wrong PSK must fail");
    }
}
