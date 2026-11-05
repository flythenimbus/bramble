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
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vault_crypto::{handshake, roster_sig};

use crate::storage;

type Res<T> = Result<T, String>;

/// Derives the key that seals pairing.json from the identity's private key.
const SEAL_INFO: &[u8] = b"bramble/desktop/extension-pairing/allowlist-seal/v1";

/// Also reserved from the webview in `secure_store`: the seal is only as private as this key.
pub(crate) const KEYCHAIN_ACCOUNT: &str = "extension-pairing-identity";

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
///
/// Any process running as the user can write this file, so `seal` signs the other fields with
/// a key only the identity yields. A file that fails it keeps no peers (see `read_trusted`).
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingFile {
    #[serde(default)]
    public_key: String,
    /// The one list kept for the whole app before each vault had its own. Frozen: nothing is
    /// added to it, and a vault with no list yet takes its links from here (see `vault_peers`).
    #[serde(default)]
    peers: Vec<PairedPeer>,
    /// The browsers linked to each vault, by vault id. A browser is served only while a vault it
    /// is linked to is the one open (see `admitted`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    vaults: BTreeMap<String, Vec<PairedPeer>>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    seal: String,
}

impl PairingFile {
    fn has_links(&self) -> bool {
        !self.peers.is_empty() || self.vaults.values().any(|peers| !peers.is_empty())
    }
}

/// Where the webview records the vault it has open, and the vaults on this device (the
/// `ACTIVE_VAULT_KEY` and `VAULT_REGISTRY_KEY` it writes to meta.json).
pub(crate) const ACTIVE_VAULT_KEY: &str = "active-vault";

/// Why a browser gets nothing: the vault open now is not one it is linked to.
pub(crate) const NOT_LINKED: &str = "not linked to the open vault";
const VAULT_REGISTRY_KEY: &str = "vault.registry";

/// Both halves together, so the two can never drift apart across separate stores.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    private_key: String,
    public_key: String,
    /// Whether pairing.json is sealed. Absent on an identity from before sealing, whose file is
    /// trusted as it stands once and sealed then.
    #[serde(default)]
    sealed: bool,
}

/// How long a Connect dialog accepts an emoji link, and how long one link waits on both answers.
pub const LINK_WINDOW_MS: u64 = 3 * 60 * 1000;

/// An open Connect dialog: emoji links are accepted until it closes or expires, one at a time.
struct LinkWindow {
    expires_at: u64,
    in_flight: bool,
}

static LINK_WINDOW: Mutex<Option<LinkWindow>> = Mutex::new(None);

/// Open the dialog's window for an emoji link. Replaces any window already open.
pub fn begin_link_window() {
    *LINK_WINDOW.lock().unwrap() = Some(LinkWindow {
        expires_at: now_ms() + LINK_WINDOW_MS,
        in_flight: false,
    });
}

/// A link attempt ended before reaching the user's screen: free the window for the next one.
pub fn end_link_attempt() {
    if let Some(window) = LINK_WINDOW.lock().unwrap().as_mut() {
        window.in_flight = false;
    }
}

/// Close the window: the dialog went away, a link failed, or one succeeded.
pub fn cancel_link_window() {
    *LINK_WINDOW.lock().unwrap() = None;
}

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

/// An Ed25519 seed only this identity yields, so a seal cannot be forged from the file.
fn seal_key(id: &Identity) -> String {
    let mut hasher = Sha256::new();
    hasher.update(SEAL_INFO);
    hasher.update(id.private_key.as_bytes());
    B64.encode(hasher.finalize())
}

fn sealed_fields(file: &PairingFile) -> Res<String> {
    // The per-vault lists joined the seal when they arrived. A file without any still verifies
    // against the seal an earlier build wrote, so upgrading keeps every link it trusted.
    let encoded = if file.vaults.is_empty() {
        serde_json::to_string(&(&file.public_key, &file.peers))
    } else {
        serde_json::to_string(&(&file.public_key, &file.peers, &file.vaults))
    };
    encoded.map_err(|e| format!("encode pairing state: {e}"))
}

fn sign_seal(id: &Identity, file: &PairingFile) -> Res<String> {
    roster_sig::roster_sign(seal_key(id), sealed_fields(file)?)
        .map_err(|e| format!("seal pairing state: {e:?}"))
}

fn seal_holds(id: &Identity, file: &PairingFile) -> bool {
    let check = || -> Res<bool> {
        let key = roster_sig::roster_sig_public_key(seal_key(id)).map_err(|e| format!("{e:?}"))?;
        roster_sig::roster_verify(key, sealed_fields(file)?, file.seal.clone())
            .map_err(|e| format!("{e:?}"))
    };
    check().unwrap_or(false)
}

fn sealed_identity() -> Res<Option<Identity>> {
    Ok(load_identity()?.filter(|id| id.sealed))
}

/// pairing.json with `peers` cut to what this app sealed: a file anything else changed keeps
/// none, so writing it is never a way onto the allowlist. Before sealing (or with no key at
/// all) the peers are returned as they stand, for listing; `identity` decides whether to trust them.
fn read_trusted(root: &Path) -> Res<PairingFile> {
    let mut file = read_file(root)?;
    if let Some(id) = sealed_identity()? {
        if !seal_holds(&id, &file) {
            if file.has_links() {
                log::warn!("pairing.json was changed outside Bramble; not trusting its browsers");
            }
            file.peers.clear();
            file.vaults.clear();
        }
    }
    Ok(file)
}

/// Write pairing.json, sealed whenever this device's identity seals it.
fn save(root: &Path, file: &mut PairingFile) -> Res<()> {
    file.seal = match sealed_identity()? {
        Some(id) => sign_seal(&id, file)?,
        None => String::new(),
    };
    write_file(root, file)
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

    if let Some(mut id) = load_identity()? {
        // The allowlist names peers that authenticate against a specific key. If the stored
        // identity is not that key, those entries are meaningless and continuing would look
        // like every browser spontaneously failing to connect.
        if !file.public_key.is_empty() && file.public_key != id.public_key {
            return Err("pairing identity does not match the stored allowlist".into());
        }
        if !id.sealed {
            // File first: a crash before the flag is stored just seals the same file again.
            file.public_key = id.public_key.clone();
            file.seal = sign_seal(&id, &file)?;
            write_file(root, &file)?;
            id.sealed = true;
            store_identity(&id)?;
        }
        return Ok((id.private_key, id.public_key));
    }

    if file.has_links() {
        return Err("This device's pairing key is missing from the keychain, so the browsers listed below can no longer connect. Disconnect them here to start again.".into());
    }

    let kp = handshake::handshake_generate_keypair().map_err(|e| format!("keygen: {e:?}"))?;
    store_identity(&Identity {
        private_key: kp.private_key.clone(),
        public_key: kp.public_key.clone(),
        sealed: true,
    })?;
    file.public_key = kp.public_key.clone();
    save(root, &mut file)?;
    Ok((kp.private_key, kp.public_key))
}

pub fn public_key(root: &Path) -> Res<String> {
    Ok(identity(root)?.1)
}

/// The vault open in the app: the active one the webview recorded, else the only one there is.
/// With several and none recorded there is no safe answer, so nobody is admitted. Before the
/// registry existed the one vault had no id, which storage calls `DEFAULT_VAULT_ID`.
fn open_vault_id(root: &Path) -> Res<Option<String>> {
    if let Some(serde_json::Value::String(id)) = storage::ops::get_meta(root, ACTIVE_VAULT_KEY)? {
        return Ok(Some(id));
    }
    Ok(match storage::ops::get_meta(root, VAULT_REGISTRY_KEY)? {
        None => Some(storage::ops::DEFAULT_VAULT_ID.to_string()),
        Some(registry) => match registry["vaults"].as_array().map(Vec::as_slice) {
            Some([only]) => only["id"].as_str().map(str::to_string),
            _ => None,
        },
    })
}

/// When a vault was made, from the registry. None for a vault it does not date.
fn vault_created_at(root: &Path, vault_id: &str) -> Res<Option<u64>> {
    let registry = storage::ops::get_meta(root, VAULT_REGISTRY_KEY)?.unwrap_or_default();
    Ok(registry["vaults"]
        .as_array()
        .and_then(|vaults| vaults.iter().find(|v| v["id"] == vault_id))
        .and_then(|v| v["createdAt"].as_f64())
        .map(|at| at as u64))
}

/// A vault's browsers. One with no list of its own yet takes the app-wide list an earlier build
/// kept, cut to the links made since the vault existed: those are the ones that already worked
/// with it. A vault the registry does not date keeps them all, so nothing that worked stops.
fn vault_peers(root: &Path, file: &PairingFile, vault_id: &str) -> Res<Vec<PairedPeer>> {
    if let Some(peers) = file.vaults.get(vault_id) {
        return Ok(peers.clone());
    }
    let since = vault_created_at(root, vault_id)?.unwrap_or(0);
    Ok(file
        .peers
        .iter()
        .filter(|p| p.paired_at >= since)
        .cloned()
        .collect())
}

/// The browsers linked to the vault open now. None when no vault is open.
pub fn paired_peers(root: &Path) -> Res<Vec<PairedPeer>> {
    let file = read_trusted(root)?;
    match open_vault_id(root)? {
        Some(vault_id) => vault_peers(root, &file, &vault_id),
        None => Ok(Vec::new()),
    }
}

/// Whether a browser may be served now: it is linked to the vault that is open. Checked when it
/// connects, on every frame it sends, and before anything is pushed to it, so a browser linked
/// to one vault gets nothing while another is open.
pub fn admitted(root: &Path, public_key: &str) -> bool {
    paired_peers(root).is_ok_and(|peers| peers.iter().any(|p| p.public_key == public_key))
}

/// Revoke a browser from the vault open now. Its next connection fails the KK handshake, and
/// a vault it is also linked to keeps it.
pub fn forget_peer(root: &Path, public_key: &str) -> Res<bool> {
    let Some(vault_id) = open_vault_id(root)? else {
        return Ok(false);
    };
    let mut file = read_trusted(root)?;
    let mut peers = vault_peers(root, &file, &vault_id)?;
    let before = peers.len();
    peers.retain(|p| p.public_key != public_key);
    let removed = peers.len() != before;
    if removed {
        file.vaults.insert(vault_id, peers);
        save(root, &mut file)?;
    }
    Ok(removed)
}

// The connection-accepting half, driven by the socket listener. Kept apart from any I/O so the
// protocol is testable end to end without it, which is where the security-critical logic wants
// its tests anyway.

/// A handshake in flight, before it has earned a place in the allowlist.
pub struct Handshake {
    pub session_id: u32,
    /// Set only for an emoji link handshake: the label the browser gave itself.
    link_label: Option<String>,
}

impl Handshake {
    /// The browser's label when this is an emoji link handshake.
    pub fn link_label(&self) -> Option<&str> {
        self.link_label.as_deref()
    }
}

/// Begin answering a connection from an established peer.
pub fn accept_known(root: &Path, peer_public_key: &str) -> Res<Handshake> {
    let (priv_key, _) = identity(root)?;
    if !admitted(root, peer_public_key) {
        return Err(NOT_LINKED.into());
    }
    let session_id = handshake::handshake_start_responder(priv_key, peer_public_key.to_string())
        .map_err(|e| format!("start responder: {e:?}"))?;
    Ok(Handshake {
        session_id,
        link_label: None,
    })
}

/// Begin answering an emoji link. Only inside an open Connect dialog, and one at a time, so
/// nothing can put a prompt in front of the user that they did not open the dialog for.
pub fn accept_link(root: &Path, label: &str) -> Res<Handshake> {
    {
        let mut window = LINK_WINDOW.lock().unwrap();
        let open = window
            .as_mut()
            .filter(|w| w.expires_at > now_ms())
            .ok_or("no link window open")?;
        if open.in_flight {
            return Err("a link is already in progress".into());
        }
        open.in_flight = true;
    }
    let started = identity(root).and_then(|(priv_key, _)| {
        handshake::handshake_link_responder(priv_key)
            .map_err(|e| format!("start link responder: {e:?}"))
    });
    match started {
        Ok(session_id) => Ok(Handshake {
            session_id,
            link_label: Some(label.to_string()),
        }),
        Err(e) => {
            cancel_link_window();
            Err(e)
        }
    }
}

/// Allowlist a browser both sides confirmed, and close the window behind it.
pub fn finish_link(root: &Path, public_key: &str, label: &str) -> Res<()> {
    cancel_link_window();
    add_peer(root, public_key, label)
}

/// Feed a handshake message through. Nothing is allowlisted here: a browser is added only once
/// both screens have confirmed its link (`finish_link`).
pub fn read_message(hs: &Handshake, message_b64: &str) -> Res<Step> {
    let result = handshake::handshake_read(hs.session_id, message_b64.to_string())
        .map_err(|e| format!("handshake read: {e:?}"))?;
    Ok(Step {
        message: result.message,
        done: result.done,
    })
}

/// One turn of a handshake: what to send back, if anything, and whether that was the last.
pub struct Step {
    pub message: Option<String>,
    pub done: bool,
}

/// Link a browser to the vault open now: the one whose Connect dialog it came through.
fn add_peer(root: &Path, public_key: &str, label: &str) -> Res<()> {
    let vault_id = open_vault_id(root)?.ok_or("no vault is open to link a browser to")?;
    let mut file = read_trusted(root)?;
    let mut peers = vault_peers(root, &file, &vault_id)?;
    // Re-pairing an existing browser refreshes it rather than adding a duplicate that would
    // then need revoking twice.
    peers.retain(|p| p.public_key != public_key);
    peers.push(PairedPeer {
        public_key: public_key.to_string(),
        label: label.to_string(),
        paired_at: now_ms(),
    });
    file.vaults.insert(vault_id, peers);
    save(root, &mut file)
}

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

    /// Link a browser the way a link both screens confirmed ends, returning its public key.
    fn link(root: &Path, label: &str) -> String {
        // The app's identity exists before any link: accept_link sets it up for the handshake.
        identity(root).unwrap();
        let kp = handshake::handshake_generate_keypair().unwrap();
        finish_link(root, &kp.public_key, label).unwrap();
        kp.public_key
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
    fn a_confirmed_link_allowlists_the_browser() {
        let _g = setup();
        let d = root();
        let ext_pub = link(d.path(), "Chrome on Mac");

        let peers = paired_peers(d.path()).unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].public_key, ext_pub);
        assert_eq!(peers[0].label, "Chrome on Mac");
    }

    #[test]
    fn a_linked_browser_reconnects() {
        let _g = setup();
        let d = root();
        let ext_pub = link(d.path(), "chrome");

        // No dialog open: this is the everyday path.
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
        let ext_pub = link(d.path(), "chrome");

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

    fn peer_json(public_key: &str) -> serde_json::Value {
        serde_json::json!({ "publicKey": public_key, "label": "rogue", "pairedAt": 1 })
    }

    #[test]
    fn a_key_planted_in_the_file_is_never_adopted() {
        let _g = setup();
        let d = root();
        // Another process seeds an identity and allowlists itself before the app first pairs.
        let planted = handshake::handshake_generate_keypair().unwrap();
        let rogue = handshake::handshake_generate_keypair().unwrap();
        fs::write(
            path(d.path()),
            serde_json::json!({
                "privateKey": planted.private_key,
                "publicKey": planted.public_key,
                "peers": [peer_json(&rogue.public_key)],
            })
            .to_string(),
        )
        .unwrap();

        assert!(accept_known(d.path(), &rogue.public_key).is_err());
        assert!(
            read_raw().unwrap().is_none(),
            "nothing adopted into the store"
        );
    }

    #[test]
    fn a_peer_written_into_the_file_is_not_trusted() {
        let _g = setup();
        let d = root();
        link(d.path(), "chrome");

        // Keep the real identity's public key and seal, and append a peer of one's own.
        let rogue = handshake::handshake_generate_keypair().unwrap();
        let mut file: serde_json::Value =
            serde_json::from_slice(&fs::read(path(d.path())).unwrap()).unwrap();
        file["peers"]
            .as_array_mut()
            .unwrap()
            .push(peer_json(&rogue.public_key));
        fs::write(path(d.path()), file.to_string()).unwrap();

        assert!(accept_known(d.path(), &rogue.public_key).is_err());
        // Fail closed: once tampered, the file vouches for nobody until browsers pair again.
        assert!(paired_peers(d.path()).unwrap().is_empty());
    }

    #[test]
    fn an_allowlist_from_before_sealing_is_trusted_once_then_sealed() {
        let _g = setup();
        let d = root();
        // What an earlier build left: an identity with no seal flag and an unsealed file.
        let id = handshake::handshake_generate_keypair().unwrap();
        let browser = handshake::handshake_generate_keypair().unwrap();
        *TEST_STORE.lock().unwrap() = Some(
            serde_json::json!({ "privateKey": id.private_key, "publicKey": id.public_key })
                .to_string(),
        );
        fs::write(
            path(d.path()),
            serde_json::json!({ "publicKey": id.public_key, "peers": [peer_json(&browser.public_key)] })
                .to_string(),
        )
        .unwrap();

        close(&accept_known(d.path(), &browser.public_key).unwrap());
        assert!(load_identity().unwrap().unwrap().sealed);

        let rogue = handshake::handshake_generate_keypair().unwrap();
        let mut file: serde_json::Value =
            serde_json::from_slice(&fs::read(path(d.path())).unwrap()).unwrap();
        file["peers"]
            .as_array_mut()
            .unwrap()
            .push(peer_json(&rogue.public_key));
        fs::write(path(d.path()), file.to_string()).unwrap();
        assert!(accept_known(d.path(), &rogue.public_key).is_err());
    }

    #[test]
    fn forgetting_one_browser_keeps_the_others_trusted() {
        let _g = setup();
        let d = root();
        let first = link(d.path(), "first");
        let second = link(d.path(), "second");

        assert!(forget_peer(d.path(), &first).unwrap());
        assert!(accept_known(d.path(), &first).is_err());
        close(&accept_known(d.path(), &second).unwrap());
    }

    #[test]
    fn an_allowlist_from_another_identity_is_refused() {
        let _g = setup();
        let d = root();
        link(d.path(), "chrome");

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

    /// Which vault is open, as the webview records it on unlock.
    fn open_vault(root: &Path, id: &str) {
        crate::storage::ops::set_meta(root, "active-vault".into(), serde_json::json!(id)).unwrap();
    }

    /// The vaults on this device and when each was made, as the webview's registry holds them.
    fn register(root: &Path, vaults: &[(&str, u64)]) {
        let records: Vec<_> = vaults
            .iter()
            .map(|(id, at)| serde_json::json!({ "id": id, "label": "", "createdAt": at }))
            .collect();
        crate::storage::ops::set_meta(
            root,
            "vault.registry".into(),
            serde_json::json!({ "vaults": records }),
        )
        .unwrap();
    }

    /// A browser on the one list an earlier build kept for the whole app, sealed as it sealed it.
    fn legacy_link(root: &Path, public_key: &str, paired_at: u64) {
        identity(root).unwrap();
        let mut file = read_trusted(root).unwrap();
        file.peers.push(PairedPeer {
            public_key: public_key.to_string(),
            label: "legacy".into(),
            paired_at,
        });
        save(root, &mut file).unwrap();
    }

    #[test]
    fn a_browser_linked_to_one_vault_is_not_admitted_while_another_is_open() {
        let _g = setup();
        let d = root();
        register(d.path(), &[("vault-a", 1), ("vault-b", 1)]);
        open_vault(d.path(), "vault-a");
        let browser = link(d.path(), "chrome");

        open_vault(d.path(), "vault-b");
        assert!(accept_known(d.path(), &browser).is_err());
        assert!(paired_peers(d.path()).unwrap().is_empty());

        open_vault(d.path(), "vault-a");
        close(&accept_known(d.path(), &browser).unwrap());
        assert_eq!(paired_peers(d.path()).unwrap().len(), 1);
    }

    #[test]
    fn links_made_before_lists_were_per_vault_go_to_the_vaults_that_existed_then() {
        let _g = setup();
        let d = root();
        let browser = handshake::handshake_generate_keypair().unwrap();
        legacy_link(d.path(), &browser.public_key, 100);
        register(d.path(), &[("older", 50), ("newer", 200)]);

        // The file an earlier build sealed still verifies, and the link stays where it worked.
        open_vault(d.path(), "older");
        close(&accept_known(d.path(), &browser.public_key).unwrap());
        // A vault made after the link never had it.
        open_vault(d.path(), "newer");
        assert!(accept_known(d.path(), &browser.public_key).is_err());
        assert!(paired_peers(d.path()).unwrap().is_empty());
    }

    #[test]
    fn disconnecting_in_one_vault_keeps_the_link_in_another() {
        let _g = setup();
        let d = root();
        let browser = handshake::handshake_generate_keypair().unwrap();
        legacy_link(d.path(), &browser.public_key, 100);
        register(d.path(), &[("vault-a", 10), ("vault-b", 20)]);

        open_vault(d.path(), "vault-b");
        assert!(forget_peer(d.path(), &browser.public_key).unwrap());
        assert!(accept_known(d.path(), &browser.public_key).is_err());

        open_vault(d.path(), "vault-a");
        close(&accept_known(d.path(), &browser.public_key).unwrap());
    }

    #[test]
    fn a_browser_written_into_a_vaults_list_is_not_trusted() {
        let _g = setup();
        let d = root();
        register(d.path(), &[("vault-a", 1), ("vault-b", 1)]);
        open_vault(d.path(), "vault-a");
        link(d.path(), "chrome");

        let rogue = handshake::handshake_generate_keypair().unwrap();
        let mut file: serde_json::Value =
            serde_json::from_slice(&fs::read(path(d.path())).unwrap()).unwrap();
        file["vaults"]["vault-b"] = serde_json::json!([peer_json(&rogue.public_key)]);
        fs::write(path(d.path()), file.to_string()).unwrap();

        open_vault(d.path(), "vault-b");
        assert!(accept_known(d.path(), &rogue.public_key).is_err());
        // Fail closed, as with the app-wide list: a tampered file vouches for nobody.
        open_vault(d.path(), "vault-a");
        assert!(paired_peers(d.path()).unwrap().is_empty());
    }

    #[test]
    fn with_several_vaults_and_none_open_nobody_is_admitted() {
        let _g = setup();
        let d = root();
        let browser = handshake::handshake_generate_keypair().unwrap();
        legacy_link(d.path(), &browser.public_key, 100);
        register(d.path(), &[("vault-a", 10), ("vault-b", 20)]);

        assert!(accept_known(d.path(), &browser.public_key).is_err());
        assert!(paired_peers(d.path()).unwrap().is_empty());
    }
}

// ---- commands: the pairing UI's surface ----

use tauri::AppHandle;

use crate::storage::data_dir;

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
