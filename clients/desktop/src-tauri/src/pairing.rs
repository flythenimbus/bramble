//! Pairing state for the browser-extension link.
//!
//! Each side holds a long-lived X25519 static keypair. On first connect they run
//! `Noise_XXpsk3` keyed on a short code the user carries from this app to the extension,
//! learn each other's static key, and allowlist it. Every connection after that is
//! `Noise_KK` against the allowlisted key, with no user interaction. All of that machinery
//! is `vault_crypto::handshake`, the same one device sync uses; this module owns the state
//! around it: identity, the allowlist, and the code's lifecycle.
//!
//! Why a code rather than a click. The approval dialog can only display what the peer
//! *claims* to be, so a malicious local process can assert any extension id and race the
//! real one to be the request the user approves. A code the attacker does not hold means its
//! handshake fails outright, and nothing rests on the user telling two identical prompts
//! apart. The same reasoning is already written into the sync enrollment, whose label is
//! commented as "attacker-controlled: context, never proof".
//!
//! See docs/desktop-port.md for the threat model this implements, including what one-time
//! pairing does *not* cover.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vault_crypto::handshake;

type Res<T> = Result<T, String>;

/// Unambiguous alphabet: no I/L/O/U or digits that read as letters, so a code read off one
/// window and typed into another does not fail on a character the user cannot distinguish.
const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTVWXYZ";

/// 8 characters over a 30-character alphabet is a little over 39 bits. Ample against online
/// guessing, given the code is single-use, expires, and burns after a handful of attempts.
const CODE_LEN: usize = 8;

/// Long enough to read a code off the screen and type it, short enough that an abandoned
/// pairing does not leave a usable secret lying around.
const CODE_TTL_MS: u64 = 3 * 60 * 1000;

/// Wrong guesses before the code is destroyed. The window is already tiny; this removes
/// online grinding as a consideration entirely.
const MAX_ATTEMPTS: u8 = 5;

/// HKDF-style domain separation, so a code can never be mistaken for key material from
/// anywhere else in the system.
const PSK_INFO: &[u8] = b"bramble/desktop/extension-pairing/psk/v1";

#[cfg_attr(test, allow(dead_code))]
const KEYCHAIN_ACCOUNT: &str = "extension-pairing-identity";

/// A browser that completed pairing and may now open authenticated sessions.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairedPeer {
    /// Base64 X25519 static public key. This is the identity; everything else is display.
    pub public_key: String,
    /// What the peer called itself (the extension id). Attacker-assertable at pairing time,
    /// so it is context for the user, never proof of anything.
    pub label: String,
    pub paired_at: u64,
}

/// On-disk pairing state: the allowlist, and a copy of the identity's public half.
///
/// No private key. That lives in the OS credential store (see `identity`), so a process that
/// can read this file learns who is paired but gains nothing it could authenticate with.
///
/// `public_key` is kept here as a fingerprint of the identity these peers were paired
/// against, and is checked on every load. Without it, an allowlist that outlived its
/// keypair would silently pair against a freshly generated identity and every browser in the
/// list would stop working with no indication why.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingFile {
    #[serde(default)]
    public_key: String,
    #[serde(default)]
    peers: Vec<PairedPeer>,
    /// An earlier build kept the private key here. Read only so it can be migrated into the
    /// credential store and removed; never written back.
    #[serde(default, skip_serializing)]
    private_key: String,
}

/// Both halves together, so the two can never drift apart across separate stores.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    private_key: String,
    public_key: String,
}

/// A pairing the user has opened but no extension has completed yet.
struct PendingCode {
    code: String,
    expires_at: u64,
    attempts: u8,
}

static PENDING: Mutex<Option<PendingCode>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn path(root: &Path) -> PathBuf {
    root.join("pairing.json")
}

fn read_file(root: &Path) -> Res<PairingFile> {
    let p = path(root);
    if !p.exists() {
        return Ok(PairingFile::default());
    }
    let raw = fs::read(&p).map_err(|e| format!("read pairing state: {e}"))?;
    // Unlike meta.json, a damaged file here must NOT silently reset: that would mint a new
    // identity and quietly drop every paired browser, turning a read glitch into a security
    // event the user never sees.
    serde_json::from_slice(&raw).map_err(|e| format!("parse pairing state: {e}"))
}

fn write_file(root: &Path, file: &PairingFile) -> Res<()> {
    let bytes = serde_json::to_vec(file).map_err(|e| format!("encode pairing state: {e}"))?;
    let p = path(root);
    let tmp = p.with_extension("tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("write pairing temp: {e}"))?;
    restrict(&tmp)?;
    fs::rename(&tmp, &p).map_err(|e| format!("rename pairing state: {e}"))
}

/// Owner-only. Does not stop a process running as the user, which is the threat the pairing
/// handshake exists for; it stops every *other* account on the machine.
fn restrict(p: &Path) -> Res<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(p, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("restrict pairing state: {e}"))?;
    }
    #[cfg(not(unix))]
    let _ = p;
    Ok(())
}

#[cfg_attr(test, allow(dead_code))]
fn entry() -> Res<keyring::Entry> {
    crate::secure_store::entry(KEYCHAIN_ACCOUNT)
}

// Only the storage leaf is swapped under test, so everything above it (generation, the
// migration, the fingerprint check) is the shipped code path. keyring's own mock store is not
// usable here: it hands out a fresh credential per `Entry::new` rather than persisting, which
// is deliberate on its part but makes "is the identity stable" untestable through it. The two
// keyring calls themselves stay uncovered by unit tests and are exercised when the app runs.
#[cfg(test)]
static TEST_STORE: Mutex<Option<String>> = Mutex::new(None);

/// How many times the storage leaf was consulted, so a test can assert the credential store
/// is not hit per call. Each hit is a password prompt on a machine whose signature the
/// keychain does not recognise.
#[cfg(test)]
static STORE_READS: Mutex<u32> = Mutex::new(0);

fn read_raw() -> Res<Option<String>> {
    #[cfg(test)]
    {
        *STORE_READS.lock().unwrap() += 1;
        Ok(TEST_STORE.lock().unwrap().clone())
    }
    #[cfg(not(test))]
    {
        match entry()?.get_password() {
            Ok(raw) => Ok(Some(raw)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("credential store read: {e}")),
        }
    }
}

fn write_raw(raw: &str) -> Res<()> {
    #[cfg(test)]
    {
        *TEST_STORE.lock().unwrap() = Some(raw.to_string());
        Ok(())
    }
    #[cfg(not(test))]
    {
        entry()?
            .set_password(raw)
            .map_err(|e| format!("credential store write: {e}"))
    }
}

/// The identity once read, because the credential store can prompt on every access.
///
/// macOS ties a keychain item's ACL to the reading binary's code signature. A development
/// build is re-signed on each `cargo build`, so it looks like a different application every
/// time and the "Always Allow" never sticks; reading per connection then turns a working link
/// into a wall of password prompts. It cannot change while the process runs, so reading it
/// once is not just an optimisation. A signed, notarised build has a stable signature and
/// prompts once ever, but the caching is worth having regardless.
/// Two layers of Option on purpose. The outer says whether the store has been consulted at
/// all; the inner is what it said. Caching only the hit was not enough: a device whose key has
/// gone missing looks up nothing to cache, so every attempt went back to the credential store
/// and prompted again. An absent key is just as stable a fact as a present one.
static CACHED: Mutex<Option<Option<Identity>>> = Mutex::new(None);

fn load_identity() -> Res<Option<Identity>> {
    if let Some(cached) = CACHED.lock().unwrap().clone() {
        return Ok(cached);
    }
    let found = match read_raw()? {
        Some(raw) => Some(
            serde_json::from_str::<Identity>(&raw)
                .map_err(|e| format!("parse stored identity: {e}"))?,
        ),
        None => None,
    };
    *CACHED.lock().unwrap() = Some(found.clone());
    Ok(found)
}

fn store_identity(id: &Identity) -> Res<()> {
    let raw = serde_json::to_string(id).map_err(|e| format!("encode identity: {e}"))?;
    write_raw(&raw)?;
    *CACHED.lock().unwrap() = Some(Some(id.clone()));
    Ok(())
}

/// This device's static keypair, generated on first call and stable after.
///
/// Held in the OS credential store: the macOS Keychain, the Windows Credential Manager, or
/// the Linux secret service. Beyond keeping it out of a readable file, the macOS keychain
/// item carries an ACL naming the app that created it, so another binary reading it prompts
/// the user rather than succeeding silently the way a 0600 file would.
fn identity(root: &Path) -> Res<(String, String)> {
    let mut file = read_file(root)?;

    // An earlier build kept the private key in pairing.json. Move it rather than generating
    // a new one, which would orphan every browser already paired against it.
    if !file.private_key.is_empty() {
        if load_identity()?.is_none() {
            store_identity(&Identity {
                private_key: std::mem::take(&mut file.private_key),
                public_key: file.public_key.clone(),
            })?;
        }
        file.private_key = String::new();
        write_file(root, &file)?;
    }

    if let Some(id) = load_identity()? {
        // The allowlist names peers that authenticate against a specific key. If the stored
        // identity is not that key, those entries are meaningless and continuing would look
        // like every browser spontaneously failing to connect.
        if !file.public_key.is_empty() && file.public_key != id.public_key {
            return Err("pairing identity does not match the stored allowlist".into());
        }
        return Ok((id.private_key, id.public_key));
    }

    if !file.peers.is_empty() {
        return Err("This device's pairing key is missing from the keychain, so the browsers listed below can no longer connect. Disconnect them here to start again.".into());
    }

    let kp = handshake::handshake_generate_keypair().map_err(|e| format!("keygen: {e:?}"))?;
    store_identity(&Identity {
        private_key: kp.private_key.clone(),
        public_key: kp.public_key.clone(),
    })?;
    file.public_key = kp.public_key.clone();
    write_file(root, &file)?;
    Ok((kp.private_key, kp.public_key))
}

pub fn public_key(root: &Path) -> Res<String> {
    Ok(identity(root)?.1)
}

pub fn paired_peers(root: &Path) -> Res<Vec<PairedPeer>> {
    Ok(read_file(root)?.peers)
}

/// Revoke a browser. The next connection from it fails the KK handshake, because its static
/// key is no longer one this device will accept.
pub fn forget_peer(root: &Path, public_key: &str) -> Res<bool> {
    let mut file = read_file(root)?;
    let before = file.peers.len();
    file.peers.retain(|p| p.public_key != public_key);
    let removed = file.peers.len() != before;
    if removed {
        write_file(root, &file)?;
    }
    Ok(removed)
}

fn random_code() -> Res<String> {
    let mut bytes = vec![0u8; CODE_LEN];
    getrandom::fill(&mut bytes).map_err(|e| format!("random: {e}"))?;
    // Modulo bias over a 30-character alphabet is at most ~2^-4 of a bit across 8 draws and
    // does not matter for a single-use secret that expires in three minutes.
    Ok(bytes
        .iter()
        .map(|b| CODE_ALPHABET[*b as usize % CODE_ALPHABET.len()] as char)
        .collect())
}

/// Open a pairing window and return the code to show the user. Replaces any code already
/// outstanding, so opening the dialog twice cannot leave two valid secrets.
pub fn begin_pairing() -> Res<String> {
    let code = random_code()?;
    *PENDING.lock().unwrap() = Some(PendingCode {
        code: code.clone(),
        expires_at: now_ms() + CODE_TTL_MS,
        attempts: 0,
    });
    Ok(code)
}

/// Close the pairing window. Called when the user dismisses the dialog: the code is a bearer
/// secret, so it must stop working the moment they stop looking at it.
pub fn cancel_pairing() {
    *PENDING.lock().unwrap() = None;
}

pub fn pairing_open() -> bool {
    let mut pending = PENDING.lock().unwrap();
    if pending.as_ref().is_some_and(|p| p.expires_at <= now_ms()) {
        *pending = None;
    }
    pending.is_some()
}

/// Take the live code, consuming an attempt. `None` once it has expired or been exhausted.
fn claim_attempt() -> Option<String> {
    let mut guard = PENDING.lock().unwrap();
    let pending = guard.as_mut()?;
    if pending.expires_at <= now_ms() {
        *guard = None;
        return None;
    }
    pending.attempts += 1;
    let code = pending.code.clone();
    if pending.attempts >= MAX_ATTEMPTS {
        *guard = None;
    }
    Some(code)
}

/// The 32-byte PSK the handshake wants, derived from the typed code. Domain-separated so the
/// code cannot collide with key material from elsewhere.
pub(crate) fn psk_for(code: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(PSK_INFO);
    // Case-fold: the alphabet is uppercase and users will type lowercase.
    hasher.update(code.trim().to_ascii_uppercase().as_bytes());
    B64.encode(hasher.finalize())
}

// The four below are the connection-accepting half, consumed by the socket listener in the
// next slice. Kept here rather than held back so the protocol is testable end to end without
// any I/O, which is where the security-critical logic wants its tests anyway.
#[allow(dead_code)]
/// A handshake in flight, before it has earned a place in the allowlist.
pub struct Handshake {
    pub session_id: u32,
    /// Set only for a pairing handshake; `None` for an established peer.
    paired_label: Option<String>,
}

/// Begin answering a connection from an established peer.
#[allow(dead_code)]
pub fn accept_known(root: &Path, peer_public_key: &str) -> Res<Handshake> {
    let (priv_key, _) = identity(root)?;
    let known = read_file(root)?
        .peers
        .iter()
        .any(|p| p.public_key == peer_public_key);
    if !known {
        return Err("unknown peer".into());
    }
    let session_id = handshake::handshake_start_responder(priv_key, peer_public_key.to_string())
        .map_err(|e| format!("start responder: {e:?}"))?;
    Ok(Handshake {
        session_id,
        paired_label: None,
    })
}

/// Begin answering a pairing attempt. Fails when no pairing window is open, which is what
/// stops a background process from pairing itself while the user is not looking.
#[allow(dead_code)]
pub fn accept_pairing(root: &Path, label: &str) -> Res<Handshake> {
    let code = claim_attempt().ok_or("no pairing in progress")?;
    let (priv_key, _) = identity(root)?;
    let session_id = handshake::handshake_enroll_responder(priv_key, psk_for(&code))
        .map_err(|e| format!("start enroll responder: {e:?}"))?;
    Ok(Handshake {
        session_id,
        paired_label: Some(label.to_string()),
    })
}

/// Feed a handshake message through. On the message that completes a *pairing* handshake the
/// peer's static key is allowlisted, which is the only place a peer is ever added: a wrong
/// code fails the AEAD before reaching here, so completion is the proof.
#[allow(dead_code)]
pub fn read_message(root: &Path, hs: &Handshake, message_b64: &str) -> Res<Step> {
    let result = handshake::handshake_read(hs.session_id, message_b64.to_string())
        .map_err(|e| format!("handshake read: {e:?}"))?;
    if result.done {
        if let Some(label) = &hs.paired_label {
            let peer = handshake::handshake_remote_static(hs.session_id)
                .map_err(|e| format!("remote static: {e:?}"))?;
            add_peer(root, &peer, label)?;
            // The code has done its job; leaving it live would allow a second pairing.
            cancel_pairing();
        }
    }
    Ok(Step {
        message: result.message,
        done: result.done,
    })
}

/// One turn of a handshake: what to send back, if anything, and whether that was the last.
#[allow(dead_code)]
pub struct Step {
    pub message: Option<String>,
    pub done: bool,
}

fn add_peer(root: &Path, public_key: &str, label: &str) -> Res<()> {
    let mut file = read_file(root)?;
    // Re-pairing an existing browser refreshes it rather than adding a duplicate that would
    // then need revoking twice.
    file.peers.retain(|p| p.public_key != public_key);
    file.peers.push(PairedPeer {
        public_key: public_key.to_string(),
        label: label.to_string(),
        paired_at: now_ms(),
    });
    write_file(root, &file)
}

#[allow(dead_code)]
pub fn close(hs: &Handshake) {
    handshake::handshake_close(hs.session_id);
}

/// Sessions are process-global in `vault_crypto`, so tests that pair must not interleave.
#[cfg(test)]
static TEST_LOCK: Mutex<()> = Mutex::new(());

/// Shared with the socket tests, which drive this module over a real connection and would
/// otherwise race it for the global session registry and the pending code.
#[cfg(test)]
pub(crate) fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    *TEST_STORE.lock().unwrap() = None;
    guard
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn root() -> TempDir {
        tempfile::tempdir().expect("temp dir")
    }

    /// Serialise, and clear the identity so each test starts fresh: the credential store is
    /// process-global where the temp dirs are not.
    fn setup() -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        *TEST_STORE.lock().unwrap() = None;
        *CACHED.lock().unwrap() = None;
        *STORE_READS.lock().unwrap() = 0;
        guard
    }

    /// Drive the extension's half in-process. The real one runs this in WASM through the same
    /// `vault_crypto::handshake`, so the protocol under test is the shipped one.
    fn extension_pairs(code: &str) -> Res<(String, u32, String)> {
        let kp = handshake::handshake_generate_keypair().map_err(|e| format!("{e:?}"))?;
        let start = handshake::handshake_enroll_initiator(kp.private_key.clone(), psk_for(code))
            .map_err(|e| format!("{e:?}"))?;
        Ok((kp.public_key, start.session_id, start.message))
    }

    /// Run a pairing to completion against the module, returning the extension's public key.
    fn pair(root: &Path, code: &str, label: &str) -> Res<String> {
        let (ext_pub, ext_session, msg1) = extension_pairs(code)?;
        let hs = accept_pairing(root, label)?;
        let msg2 = read_message(root, &hs, &msg1)?
            .message
            .ok_or("expected msg2")?;
        let msg3 = handshake::handshake_read(ext_session, msg2)
            .map_err(|e| format!("{e:?}"))?
            .message
            .ok_or("expected msg3")?;
        read_message(root, &hs, &msg3)?;
        close(&hs);
        handshake::handshake_close(ext_session);
        Ok(ext_pub)
    }

    #[test]
    fn a_missing_key_is_looked_up_once_not_once_per_attempt() {
        // The regression that produced five macOS password prompts in a row. Caching only a
        // successful lookup meant a device whose key had gone missing went back to the
        // credential store on every single attempt, and each visit prompted.
        let _g = setup();
        let d = root();
        let stranger = handshake::handshake_generate_keypair().unwrap();
        add_peer(d.path(), &stranger.public_key, "orphan").unwrap();

        for _ in 0..5 {
            assert!(public_key(d.path()).is_err(), "should stay broken");
        }
        assert_eq!(
            *STORE_READS.lock().unwrap(),
            1,
            "an absent key is as stable a fact as a present one"
        );
    }

    #[test]
    fn a_present_key_is_read_once_however_many_connections() {
        let _g = setup();
        let d = root();
        public_key(d.path()).unwrap();
        let after_first = *STORE_READS.lock().unwrap();
        for _ in 0..5 {
            public_key(d.path()).unwrap();
        }
        assert_eq!(*STORE_READS.lock().unwrap(), after_first);
    }

    #[test]
    fn the_missing_key_error_tells_the_user_how_to_recover() {
        // The message is the only place the recovery appears; the UI shows it verbatim.
        let _g = setup();
        let d = root();
        let stranger = handshake::handshake_generate_keypair().unwrap();
        add_peer(d.path(), &stranger.public_key, "orphan").unwrap();

        let err = public_key(d.path()).unwrap_err();
        assert!(err.contains("Disconnect"), "no recovery offered: {err}");
    }

    #[test]
    fn identity_is_stable_across_calls() {
        let _g = setup();
        let d = root();
        let first = public_key(d.path()).unwrap();
        assert_eq!(public_key(d.path()).unwrap(), first);
        assert!(!first.is_empty());
    }

    #[test]
    fn pairing_allowlists_the_peer() {
        let _g = setup();
        let d = root();
        let code = begin_pairing().unwrap();
        let ext_pub = pair(d.path(), &code, "chrome-extension://abc").unwrap();

        let peers = paired_peers(d.path()).unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].public_key, ext_pub);
        assert_eq!(peers[0].label, "chrome-extension://abc");
    }

    #[test]
    fn a_wrong_code_never_completes() {
        let _g = setup();
        let d = root();
        begin_pairing().unwrap();
        // The attacker guesses. XXpsk3 mixes the PSK in, so this fails inside the AEAD
        // rather than at any check of ours.
        assert!(pair(d.path(), "WRONGCOD", "chrome-extension://evil").is_err());
        assert!(paired_peers(d.path()).unwrap().is_empty());
    }

    #[test]
    fn no_pairing_window_means_no_pairing() {
        let _g = setup();
        let d = root();
        cancel_pairing();
        // A process connecting while the user is not pairing gets nowhere, whatever it claims.
        assert!(accept_pairing(d.path(), "chrome-extension://evil").is_err());
    }

    #[test]
    fn the_code_is_single_use() {
        let _g = setup();
        let d = root();
        let code = begin_pairing().unwrap();
        pair(d.path(), &code, "first").unwrap();
        // Completion closed the window, so the same code cannot pair a second browser.
        assert!(!pairing_open());
        assert!(accept_pairing(d.path(), "second").is_err());
        assert_eq!(paired_peers(d.path()).unwrap().len(), 1);
    }

    #[test]
    fn the_code_burns_after_repeated_failures() {
        let _g = setup();
        let d = root();
        begin_pairing().unwrap();
        for _ in 0..MAX_ATTEMPTS {
            let _ = accept_pairing(d.path(), "guesser");
        }
        assert!(!pairing_open(), "code should be spent");
        assert!(accept_pairing(d.path(), "guesser").is_err());
    }

    #[test]
    fn an_expired_code_is_refused() {
        let _g = setup();
        let d = root();
        let code = begin_pairing().unwrap();
        // Reach in and age it, rather than sleeping out a three-minute TTL.
        PENDING.lock().unwrap().as_mut().unwrap().expires_at = now_ms() - 1;
        assert!(!pairing_open());
        assert!(pair(d.path(), &code, "late").is_err());
        assert!(paired_peers(d.path()).unwrap().is_empty());
    }

    #[test]
    fn a_paired_peer_reconnects_without_a_code() {
        let _g = setup();
        let d = root();
        let code = begin_pairing().unwrap();
        let ext_pub = pair(d.path(), &code, "chrome").unwrap();

        // No pairing window open: this is the everyday path.
        assert!(!pairing_open());
        let hs = accept_known(d.path(), &ext_pub).unwrap();
        close(&hs);
    }

    #[test]
    fn an_unpaired_peer_is_refused_even_with_a_real_key() {
        let _g = setup();
        let d = root();
        let stranger = handshake::handshake_generate_keypair().unwrap();
        assert!(accept_known(d.path(), &stranger.public_key).is_err());
    }

    #[test]
    fn forgetting_a_peer_revokes_it() {
        let _g = setup();
        let d = root();
        let code = begin_pairing().unwrap();
        let ext_pub = pair(d.path(), &code, "chrome").unwrap();

        assert!(forget_peer(d.path(), &ext_pub).unwrap());
        assert!(accept_known(d.path(), &ext_pub).is_err());
        assert!(!forget_peer(d.path(), &ext_pub).unwrap());
    }

    #[test]
    fn re_pairing_replaces_rather_than_duplicates() {
        let _g = setup();
        let d = root();
        let kp = handshake::handshake_generate_keypair().unwrap();
        add_peer(d.path(), &kp.public_key, "old").unwrap();
        add_peer(d.path(), &kp.public_key, "new").unwrap();

        let peers = paired_peers(d.path()).unwrap();
        assert_eq!(peers.len(), 1, "one revoke should remove one browser");
        assert_eq!(peers[0].label, "new");
    }

    #[test]
    fn a_damaged_state_file_errors_rather_than_resetting() {
        let _g = setup();
        let d = root();
        public_key(d.path()).unwrap();
        fs::write(path(d.path()), b"{ truncated").unwrap();
        // Silently starting over would mint a new identity and drop every paired browser
        // without telling anyone.
        assert!(public_key(d.path()).is_err());
        assert!(paired_peers(d.path()).is_err());
    }

    #[test]
    fn a_legacy_file_key_migrates_into_the_credential_store() {
        let _g = setup();
        let d = root();
        // What the previous build wrote: the private key inline.
        let kp = handshake::handshake_generate_keypair().unwrap();
        fs::write(
            path(d.path()),
            serde_json::json!({
                "privateKey": kp.private_key,
                "publicKey": kp.public_key,
                "peers": [],
            })
            .to_string(),
        )
        .unwrap();

        // Same identity, not a fresh one: regenerating would orphan every paired browser.
        assert_eq!(public_key(d.path()).unwrap(), kp.public_key);
        assert!(
            read_raw().unwrap().is_some(),
            "key should now be in the store"
        );

        let on_disk = fs::read_to_string(path(d.path())).unwrap();
        assert!(
            !on_disk.contains(&kp.private_key),
            "private key should no longer be on disk"
        );
    }

    #[test]
    fn an_allowlist_from_another_identity_is_refused() {
        let _g = setup();
        let d = root();
        let code = begin_pairing().unwrap();
        pair(d.path(), &code, "chrome").unwrap();

        // A restore from another machine: different credential store, same allowlist file.
        // The cache goes too, because this is a scenario a fresh process would meet.
        *TEST_STORE.lock().unwrap() = None;
        *CACHED.lock().unwrap() = None;
        public_key(d.path()).unwrap_err();
    }

    #[test]
    fn peers_without_a_stored_key_are_refused_rather_than_silently_reset() {
        let _g = setup();
        let d = root();
        let stranger = handshake::handshake_generate_keypair().unwrap();
        add_peer(d.path(), &stranger.public_key, "orphan").unwrap();
        *TEST_STORE.lock().unwrap() = None;
        *CACHED.lock().unwrap() = None;

        // Generating a new identity here would leave a browser listed that can never connect.
        // What the message SAYS is asserted separately; this is about the guard firing.
        assert!(public_key(d.path()).is_err());
    }

    #[test]
    fn codes_use_an_unambiguous_alphabet() {
        let _g = setup();
        let code = begin_pairing().unwrap();
        assert_eq!(code.len(), CODE_LEN);
        assert!(
            code.chars().all(|c| CODE_ALPHABET.contains(&(c as u8))),
            "code {code} strayed outside the alphabet"
        );
    }

    #[test]
    fn the_psk_is_case_insensitive_but_code_specific() {
        assert_eq!(psk_for("ABC23456"), psk_for("abc23456"));
        assert_eq!(psk_for(" ABC23456 "), psk_for("ABC23456"));
        assert_ne!(psk_for("ABC23456"), psk_for("ABC23457"));
    }
}

// ---- commands: the pairing UI's surface ----

use tauri::AppHandle;

use crate::storage::data_dir;

/// Open a pairing window and hand back the code to display. The code is a bearer secret for
/// its lifetime, so the UI must show it and nothing else must log it.
#[tauri::command]
pub fn pairing_begin() -> Result<String, String> {
    begin_pairing()
}

/// Called when the user closes the pairing dialog. Not merely tidiness: an abandoned code
/// that stayed live would be a usable secret nobody is watching.
#[tauri::command]
pub fn pairing_cancel() {
    cancel_pairing();
}

#[tauri::command]
pub fn pairing_is_open() -> bool {
    pairing_open()
}

#[tauri::command]
pub fn pairing_list(app: AppHandle) -> Result<Vec<PairedPeer>, String> {
    paired_peers(&data_dir(&app)?)
}

#[tauri::command]
pub fn pairing_forget(app: AppHandle, public_key: String) -> Result<bool, String> {
    forget_peer(&data_dir(&app)?, &public_key)
}

/// This device's static public key, for showing the user which identity a browser paired to.
#[tauri::command]
pub fn pairing_public_key(app: AppHandle) -> Result<String, String> {
    public_key(&data_dir(&app)?)
}
