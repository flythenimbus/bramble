//! The sync host's crypto, exposed to the webview as commands.
//!
//! Sync runs *in the webview* on desktop, unlike the extension (whose MV3 service worker has
//! no DOM, so its host lives in an offscreen document). macOS WKWebView turns out to expose
//! `RTCPeerConnection`, `RTCDataChannel` and `WebSocket`, so the transport, the relay client
//! and the merge engine all run as `@core` already writes them, with no native WebRTC bridge
//! and no shim re-creating the browser API. That was worth checking before building one.
//!
//! What cannot run in the webview is the crypto: the VEK lives in this process and never
//! crosses into it. So the host calls these, exactly as mobile's host calls its uniffi
//! bindings. Every one is a thin wrapper; the shapes already match what `@core/sync` expects
//! because the core serializes camelCase.
//!
//! See docs/desktop-port.md.

use vault_crypto::{handshake, nostr, roster_sig, CryptoError};

type CmdResult<T> = Result<T, String>;

fn map<T>(r: Result<T, CryptoError>) -> CmdResult<T> {
    r.map_err(|e| e.to_string())
}

// ---- Noise handshake: enrollment (XXpsk3) and roster-authenticated channels (KK) ----

#[tauri::command]
pub fn sync_handshake_generate_keypair() -> CmdResult<handshake::KeypairResult> {
    map(handshake::handshake_generate_keypair())
}

#[tauri::command]
pub fn sync_handshake_start_initiator(
    local_priv_b64: String,
    remote_pub_b64: String,
) -> CmdResult<handshake::StartResult> {
    map(handshake::handshake_start_initiator(
        local_priv_b64,
        remote_pub_b64,
    ))
}

#[tauri::command]
pub fn sync_handshake_start_responder(
    local_priv_b64: String,
    remote_pub_b64: String,
) -> CmdResult<u32> {
    map(handshake::handshake_start_responder(
        local_priv_b64,
        remote_pub_b64,
    ))
}

#[tauri::command]
pub fn sync_handshake_enroll_initiator(
    local_priv_b64: String,
    psk_b64: String,
) -> CmdResult<handshake::StartResult> {
    map(handshake::handshake_enroll_initiator(
        local_priv_b64,
        psk_b64,
    ))
}

#[tauri::command]
pub fn sync_handshake_enroll_responder(local_priv_b64: String, psk_b64: String) -> CmdResult<u32> {
    map(handshake::handshake_enroll_responder(
        local_priv_b64,
        psk_b64,
    ))
}

#[tauri::command]
pub fn sync_handshake_read(
    session_id: u32,
    message_b64: String,
) -> CmdResult<handshake::ReadResult> {
    map(handshake::handshake_read(session_id, message_b64))
}

#[tauri::command]
pub fn sync_handshake_encrypt(session_id: u32, plaintext: String) -> CmdResult<String> {
    map(handshake::handshake_encrypt(session_id, plaintext))
}

#[tauri::command]
pub fn sync_handshake_decrypt(session_id: u32, ciphertext_b64: String) -> CmdResult<String> {
    map(handshake::handshake_decrypt(session_id, ciphertext_b64))
}

#[tauri::command]
pub fn sync_handshake_remote_static(session_id: u32) -> CmdResult<String> {
    map(handshake::handshake_remote_static(session_id))
}

#[tauri::command]
pub fn sync_handshake_close(session_id: u32) {
    handshake::handshake_close(session_id)
}

// ---- Nostr event signing, for the relay used as signaling ----

#[tauri::command]
pub fn sync_nostr_generate_key() -> CmdResult<nostr::NostrKey> {
    map(nostr::nostr_generate_key())
}

#[tauri::command]
pub fn sync_nostr_public_key(secret_b64: String) -> CmdResult<String> {
    map(nostr::nostr_public_key(secret_b64))
}

#[tauri::command]
pub fn sync_nostr_sign(secret_b64: String, message_hex: String) -> CmdResult<String> {
    map(nostr::nostr_sign(secret_b64, message_hex))
}

#[tauri::command]
pub fn sync_nostr_verify(
    public_key_hex: String,
    message_hex: String,
    signature_hex: String,
) -> CmdResult<bool> {
    map(nostr::nostr_verify(
        public_key_hex,
        message_hex,
        signature_hex,
    ))
}

// ---- Ed25519 roster-entry signing, and password-derived admission ----

#[tauri::command]
pub fn sync_roster_sig_generate_key() -> CmdResult<roster_sig::RosterKey> {
    map(roster_sig::roster_sig_generate_key())
}

#[tauri::command]
pub fn sync_roster_sig_public_key(secret_b64: String) -> CmdResult<String> {
    map(roster_sig::roster_sig_public_key(secret_b64))
}

#[tauri::command]
pub fn sync_roster_sign(secret_b64: String, message: String) -> CmdResult<String> {
    map(roster_sig::roster_sign(secret_b64, message))
}

#[tauri::command]
pub fn sync_roster_verify(
    public_key_b64: String,
    message: String,
    signature_b64: String,
) -> CmdResult<bool> {
    map(roster_sig::roster_verify(
        public_key_b64,
        message,
        signature_b64,
    ))
}

#[tauri::command]
pub fn sync_roster_admission_public_key(password: String, salt_b64: String) -> CmdResult<String> {
    map(roster_sig::roster_admission_public_key(password, salt_b64))
}

#[tauri::command]
pub fn sync_roster_admission_sign(
    password: String,
    salt_b64: String,
    message: String,
) -> CmdResult<String> {
    map(roster_sig::roster_admission_sign(
        password, salt_b64, message,
    ))
}
