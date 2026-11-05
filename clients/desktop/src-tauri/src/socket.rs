//! The local socket the browser proxy connects to.
//!
//! Native messaging inverts the lifecycle: the browser *spawns* its host, but this app is
//! resident. So a small spawned proxy relays between the browser's stdio and this socket, and
//! this is the resident end of that pipe.
//!
//! The socket is the reason pairing exists. Owner-only permissions keep other accounts out,
//! but every process running as the user can connect, so reaching this listener proves
//! nothing on its own. Authentication is entirely the Noise handshake in `pairing`: a caller
//! that cannot complete it gets no further, and the proxy itself holds no key, which is what
//! reduces it to an untrusted relay. See docs/desktop-port.md.
//!
//! Framing is a 4-byte little-endian length followed by JSON, the same shape Chrome's native
//! messaging uses, so the proxy can pump bytes between the two without parsing anything.

use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Condvar, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use vault_crypto::handshake;

use crate::{index_store, ipc, pairing, pairing::NOT_LINKED};

/// Chrome caps a native-messaging frame at 1 MB. Nothing this protocol carries comes near it,
/// so a larger frame is a bug or an attempt to exhaust memory, not a big credential.
const MAX_FRAME: u32 = 1024 * 1024;

/// Wire protocol version. Present so a future extension talking to an older app fails with
/// something legible rather than a parse error deep in a handshake.
const PROTOCOL_VERSION: u32 = 1;

/// What a fresh connection wants.
// `rename_all` on an enum renames the VARIANTS; the fields inside them need
// `rename_all_fields`. Without it `publicKey` silently fails to match `public_key`, the hello
// parses as garbage, and the connection closes with no reply at all.
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Hello {
    /// An established browser reconnecting, identified by its allowlisted static key.
    Hello { v: u32, public_key: String },
    /// First contact with no code: both screens show emoji from the handshake and the user
    /// confirms on both. Accepted only while a Connect dialog is open.
    Link {
        v: u32,
        /// What the browser calls itself. Attacker-assertable: shown, never trusted.
        label: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Reply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    done: bool,
}

impl Reply {
    fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: None,
            error: Some(msg.into()),
            done: false,
        }
    }
    fn step(message: Option<String>, done: bool) -> Self {
        Self {
            ok: true,
            message,
            error: None,
            done,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandshakeFrame {
    message: String,
}

/// An application frame, sealed under the completed Noise session. Everything after the
/// handshake is one of these; the proxy relays them without being able to read them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealedFrame {
    sealed: String,
}

/// What the browser can ask for once authenticated.
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Request {
    /// Metadata for a hostname. Never answers with a secret.
    Query { hostname: String },
    /// The credential for one entry, which is the call that hands one over.
    Fetch { id: String },
    /// The invite a browser needs to join this vault's sync group.
    ///
    /// Answered ONLY while the user has an invite armed, which means they clicked the button and
    /// re-entered their master password moments ago. An established link is not enough: pairing
    /// this browser last week authenticated it, and authentication is not consent to hand over
    /// the vault today. See docs/desktop-port.md.
    SyncInvite,
    /// What the open vault holds, for the browser deciding what linking does. Answered only to
    /// the browser that paired in the open Connect dialog, and only while unlocked.
    VaultSummary,
    /// This app's sync device public key, so a browser can work out whether the vault it is
    /// looking at is one this app shares.
    ///
    /// Answered whether or not the vault is locked, unlike everything else here, and that is
    /// safe rather than an oversight: the key identifies this DEVICE, not any vault, and it is
    /// published in the roster to every group member already. Nothing about which vault is open
    /// leaves the app; the browser compares it against its own rosters and draws its own
    /// conclusion.
    SyncIdentity,
    /// The hostname of the page this browser is looking at, reported when it changes.
    ///
    /// So the panel can say where a fill would land before the user commits to one. Not trusted
    /// for any decision: the browser is the only thing that can authorize a fill, because only
    /// it knows what page is really in front of the user. This is for display.
    ActiveTab { hostname: String },
    /// One frame of device sync, on its way to the webview that runs the sync host.
    ///
    /// Not request/response like the other two: sync is a conversation, and either side speaks
    /// first. The frame is already sealed under sync's OWN Noise session, keyed by the two
    /// devices' roster identities, so this layer relays it without being able to read it. That
    /// is Noise inside Noise, deliberately: the outer session authenticates this browser
    /// INSTALL to this app, the inner one authenticates a roster DEVICE to the group, and only
    /// the inner identity is the one revocation acts on. See docs/desktop-port.md.
    Sync {
        frame: String,
        /// Which session the frame belongs to: absent is ongoing sync, `enroll` the vault copy.
        #[serde(default)]
        room: Option<String>,
    },
    /// What this browser speaks beyond the original protocol, answered with what this app does.
    ///
    /// The one way a capability is learned, because both ends have an older self in the wild
    /// that would misread an unknown frame: an old extension takes any frame that is not sync or
    /// fill as the answer to its pending request, and an old app answers an unknown op with an
    /// error the extension would take the same way. So nothing new is sent to a peer until that
    /// peer has said it understands it, in a request an old app answers harmlessly.
    Caps { caps: Vec<String> },
    /// One frame of attachment transfer, on its way to the webview's file session. Relayed
    /// like `Sync`, on a numbered stream (see @core/sync/transport/blob-link).
    Blob { stream: u32, frame: String },
    /// Offer sync on this connection again. The browser asks when its sync starts on a link
    /// that was up before it, so the offer made at connect went unheard. Answered, so it keeps
    /// the link; an app from before this answers with an error and the browser reconnects.
    SyncRestart,
    /// The browser holds the vault now, so its pending link is listed (`pairing::complete_link`).
    LinkComplete,
}

/// What a browser whose pairing is still pending hears when it asks for a credential.
const PAIRING_PENDING: &str = "pairing not complete";

/// Whether this connected browser's pairing is complete (`pairing::listed`).
fn listed_peer(peer_id: &str) -> bool {
    outboxes()
        .lock()
        .ok()
        .and_then(|b| b.get(peer_id).map(|o| pairing::listed(&o.root, peer_id)))
        .unwrap_or(false)
}

/// The capability that carries attachment bytes over the link.
const CAP_FILES: &str = "files";

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Answer {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// Set for a query.
    #[serde(skip_serializing_if = "Option::is_none")]
    matches: Option<Vec<index_store::MatchSummary>>,
    /// Set for a sync-invite claim, and only then.
    #[serde(skip_serializing_if = "Option::is_none")]
    invite: Option<String>,
    /// Set for a sync-identity request, and only then.
    #[serde(skip_serializing_if = "Option::is_none")]
    identity: Option<String>,
    /// Set for a vault-summary request, and only then.
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<VaultSummary>,
    /// Set for a fetch, and only then.
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    totp: Option<String>,
    /// Set for a caps request, and only then.
    #[serde(skip_serializing_if = "Option::is_none")]
    caps: Option<Vec<String>>,
}

impl Answer {
    /// Success with nothing set: each answer then sets only the field it carries.
    fn ok() -> Self {
        Self {
            ok: true,
            ..Self::default()
        }
    }

    fn error(msg: &str) -> Self {
        Self {
            error: Some(msg.to_string()),
            ..Self::default()
        }
    }
}

/// One browser's reported page: which connection reported it, the page, and report order.
struct Reported {
    link: u64,
    hostname: String,
    seq: u64,
}

/// Each browser's last reported page, by peer id. A browser only ever changes its own entry.
static REPORTED: OnceLock<Mutex<HashMap<String, Reported>>> = OnceLock::new();
static NEXT_REPORT: AtomicU64 = AtomicU64::new(1);

fn reported() -> &'static Mutex<HashMap<String, Reported>> {
    REPORTED.get_or_init(|| Mutex::new(HashMap::new()))
}

fn record_page(peer_id: &str, link: u64, hostname: String) {
    let Ok(mut map) = reported().lock() else {
        return;
    };
    if hostname.is_empty() {
        map.remove(peer_id);
    } else {
        let seq = NEXT_REPORT.fetch_add(1, Ordering::Relaxed);
        map.insert(
            peer_id.to_string(),
            Reported {
                link,
                hostname,
                seq,
            },
        );
    }
}

fn forget_page(peer_id: &str, link: u64) {
    if let Ok(mut map) = reported().lock() {
        if map.get(peer_id).is_some_and(|r| r.link == link) {
            map.remove(peer_id);
        }
    }
}

/// The most recent reporter and its page: the browser a panel fill is for.
fn reported_page() -> Option<(String, String)> {
    let map = reported().lock().ok()?;
    map.iter()
        .max_by_key(|(_, r)| r.seq)
        .map(|(peer, r)| (peer.clone(), r.hostname.clone()))
}

/// Where a fill from the panel would land, as the browser last reported it. Empty when no
/// browser is connected or it is not on a page worth naming.
#[tauri::command]
pub fn spotlight_active_tab() -> Option<String> {
    reported_page().map(|(_, host)| host)
}

/// Fill an entry on the page in front of the user, through a browser that need not be unlocked.
///
/// This hands over ONE credential, which is the whole point of the link: the user should not have
/// to unlock twice, so a locked browser cannot fill from a vault it cannot read and the app has
/// to do it for them. The VEK never crosses, only the entry they just chose.
///
/// The user's selection in the panel IS the authorization, made while this app was unlocked. On
/// top of that the entry is checked against the page the browser last reported, so a wrong tab in
/// front of the user is caught rather than filled. That report comes from the browser and a
/// compromised one could lie about it, which is why it is a second line and not the only one: the
/// panel names the page before the user commits.
#[tauri::command]
pub fn spotlight_request_fill(id: String) -> Result<(), String> {
    if vault_crypto::is_locked() {
        return Err("locked".into());
    }
    let entry = index_store::secret_for(&id).ok_or("unknown entry")?;
    // The browser that last reported a page is the one being filled; with none, nothing is sent.
    let (peer_id, page) = reported_page().ok_or("no browser page")?;
    if !listed_peer(&peer_id) {
        return Err(PAIRING_PENDING.into());
    }
    // Only where the entry belongs. A login with no hostnames at all is not pinned to anywhere,
    // so it is left to the user's choice rather than refused.
    if !entry.hostnames.is_empty()
        && !entry
            .hostnames
            .iter()
            .any(|h| h.eq_ignore_ascii_case(&page) || page.ends_with(&format!(".{h}")))
    {
        return Err(format!("that entry is not for {page}"));
    }
    let frame = serde_json::json!({
        "fill": {
            "username": entry.username,
            "password": entry.password,
            "totp": entry.totp,
        }
    });
    queue(&peer_id, frame, false)?;
    log::info!("panel fill: asked the browser on {page}");
    Ok(())
}

/// This device's sync public key, published by the webview at startup.
///
/// Held here rather than read on demand because the private half lives in the OS credential
/// store, and touching that from a socket thread would put a Keychain prompt in front of the
/// user at a moment they did not ask for anything.
static SYNC_IDENTITY: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn sync_identity() -> &'static Mutex<Option<String>> {
    SYNC_IDENTITY.get_or_init(|| Mutex::new(None))
}

/// Publish this device's sync public key for browsers to ask about.
#[tauri::command]
pub fn link_set_sync_identity(public_key: String) {
    if let Ok(mut slot) = sync_identity().lock() {
        *slot = Some(public_key);
    }
}

/// The sync invite a browser may claim, and when it stops being claimable.
///
/// Deliberately narrow: one invite, single-use, and short-lived. It carries the enrollment PSK,
/// which is a bearer secret worth the vault, so the window it exists in is the window the user is
/// looking at a code on screen.
static ARMED_INVITE: OnceLock<Mutex<Option<ArmedInvite>>> = OnceLock::new();

struct ArmedInvite {
    payload: String,
    expires_at: Instant,
    /// The browser that paired while this invite was armed: the only one that may claim it.
    bound: Option<String>,
}

fn armed() -> &'static Mutex<Option<ArmedInvite>> {
    ARMED_INVITE.get_or_init(|| Mutex::new(None))
}

/// Arm the invite a browser can claim, for `ttl_ms`. Replaces any previous one: a new invite
/// supersedes, so an abandoned one cannot be claimed later.
#[tauri::command]
pub fn link_arm_sync_invite(payload: String, ttl_ms: u64) -> Result<(), String> {
    let mut slot = armed().lock().map_err(|_| "invite lock poisoned")?;
    *slot = Some(ArmedInvite {
        payload,
        expires_at: Instant::now() + Duration::from_millis(ttl_ms),
        bound: None,
    });
    Ok(())
}

/// What the Connect dialog's vault holds: its name, whether it is empty, and how many entries.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VaultSummary {
    pub name: String,
    pub empty: bool,
    pub entries: u64,
}

static VAULT_SUMMARY: Mutex<Option<VaultSummary>> = Mutex::new(None);

/// Published by the Connect dialog while it is open, cleared when it closes.
#[tauri::command]
pub fn link_set_vault_summary(summary: Option<VaultSummary>) {
    if let Ok(mut slot) = VAULT_SUMMARY.lock() {
        *slot = summary;
    }
}

/// The summary, for the browser the armed invite is bound to and nobody else.
fn vault_summary_for(peer_id: &str) -> Option<VaultSummary> {
    let bound = armed()
        .lock()
        .ok()?
        .as_ref()
        .filter(|i| Instant::now() <= i.expires_at)
        .and_then(|i| i.bound.clone())?;
    if bound != peer_id {
        return None;
    }
    VAULT_SUMMARY.lock().ok()?.clone()
}

/// Bind the armed invite to the browser that just paired in this dialog. The first pairing wins:
/// a later one, even a second browser, cannot take it over.
pub fn bind_invite(peer_id: &str) -> bool {
    let Ok(mut slot) = armed().lock() else {
        return false;
    };
    match slot.as_mut().filter(|i| i.bound.is_none()) {
        Some(invite) => {
            invite.bound = Some(peer_id.to_string());
            true
        }
        None => false,
    }
}

/// Disarm, for a dialog the user closed. Dismissing is a refusal, and abandons a link still
/// pending: its connection goes too.
#[tauri::command]
pub fn link_clear_sync_invite(app: AppHandle) {
    clear_sync_invite(crate::storage::data_dir(&app).ok().as_deref());
}

/// `link_clear_sync_invite`, for callers without an app handle. With no `root`, the pending
/// link's connection is left to fail its next frame.
pub fn clear_sync_invite(root: Option<&Path>) {
    pairing::drop_pending();
    if let Some(root) = root {
        vault_opened(root);
    }
    if let Ok(mut slot) = armed().lock() {
        *slot = None;
    }
}

/// Take the armed invite, if there is a live one. Single-use: claiming it disarms it, so a second
/// browser racing for the same code gets nothing.
fn claim_invite(peer_id: &str) -> Option<String> {
    let mut slot = armed().lock().ok()?;
    if slot.as_ref()?.bound.as_deref() != Some(peer_id) {
        return None;
    }
    let invite = slot.take()?;
    if Instant::now() > invite.expires_at {
        return None; // expired: dropped by the take above
    }
    Some(invite.payload)
}

/// The webview, once the app has one. Absent under `cargo test`, where emitting is a no-op:
/// the socket is exercised directly there, with no window to deliver an event to.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Outbound queues, one per live link, keyed by the browser's static public key.
///
/// A single queue per link is what keeps the Noise nonce sequence honest. Answers and pushed
/// sync frames come from different threads, and Noise numbers its transport frames in order, so
/// two threads encrypting concurrently would produce frames the far side cannot decrypt in the
/// order they arrive. Everything outbound goes through here as plaintext and is sealed by the
/// one writer thread that drains it.
/// The generation distinguishes one link to a browser from its replacement: a reconnect
/// registers a new one, and the connection it displaced must not remove it on the way out.
static OUTBOXES: OnceLock<Mutex<HashMap<String, Outbox>>> = OnceLock::new();
static NEXT_LINK: AtomicU64 = AtomicU64::new(1);

struct Outbox {
    link: u64,
    tx: mpsc::Sender<String>,
    /// The browser said it speaks files (`Caps`). Until then no file frame is sent to it: an
    /// extension that predates them would take one for the answer to its pending request.
    files: bool,
    /// The data folder, for asking whether this browser is still admitted (pairing::admitted).
    root: PathBuf,
    /// The connection, to close when another vault opens (see `vault_opened`).
    closer: ipc::Stream,
}

fn outboxes() -> &'static Mutex<HashMap<String, Outbox>> {
    OUTBOXES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Give the socket a window to notify. Separate from `listen` because the link works without
/// one: a browser can be connected and answering fills while no window is open, and the tests
/// exercise the socket with no app at all.
pub fn attach(app: AppHandle) {
    let _ = APP.set(app);
}

/// Bring the vault window forward. Whoever pressed Link is looking at the browser, and the
/// symbols they have to compare just appeared here. On the main thread, which macOS wants for
/// the Dock icon the window brings back with it.
fn bring_forward() {
    if let Some(app) = APP.get() {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || crate::lifetime::show_main(&handle));
    }
}

fn emit(event: &str, payload: serde_json::Value) {
    if let Some(app) = APP.get() {
        let _ = app.emit(event, payload);
    }
}

/// Hand a frame from the webview's sync host to one browser. Errors when that browser is not
/// connected, which is ordinary: a peer that went away is not a failure of the caller.
#[tauri::command]
pub fn link_sync_send(peer_id: String, frame: String, room: Option<String>) -> Result<(), String> {
    let mut body = serde_json::json!({ "sync": frame });
    if let Some(room) = room {
        body["room"] = serde_json::Value::String(room);
    }
    queue(&peer_id, body, false)
}

/// Queue a frame for one browser. A file frame goes only to a connection that said it speaks
/// files (see `Outbox::files`).
fn queue(peer_id: &str, body: serde_json::Value, files: bool) -> Result<(), String> {
    let boxes = outboxes().lock().map_err(|_| "outbox lock poisoned")?;
    let outbox = boxes.get(peer_id).ok_or("no such peer")?;
    if !pairing::admitted(&outbox.root, peer_id) {
        return Err(NOT_LINKED.into());
    }
    if files && !outbox.files {
        return Err("that browser does not speak files".into());
    }
    outbox
        .tx
        .send(body.to_string())
        .map_err(|_| "link closed".to_string())
}

/// Close the connections of browsers not linked to the vault that is open now. Called when the
/// webview records another vault as open; each one's next frame would be refused anyway, but a
/// browser that just sits there should not stay connected (or be the one a panel fill picks).
pub fn vault_opened(root: &Path) {
    if let Ok(boxes) = outboxes().lock() {
        for (peer_id, outbox) in boxes.iter() {
            if !pairing::admitted(root, peer_id) {
                ipc::shutdown(&outbox.closer);
            }
        }
    }
}

/// One connected browser, as reported to a webview catching up.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedPeer {
    pub peer_id: String,
    /// The same generation the events carry, so a catch-up entry and an event about the same
    /// connection are recognisably the same connection rather than two.
    pub link: u64,
}

/// The browsers connected right now, so a webview that opened after they did can pick them up
/// rather than waiting for a reconnect that may not come until the browser restarts.
#[tauri::command]
pub fn link_sync_peers() -> Vec<ConnectedPeer> {
    connected(|_| true)
}

fn connected(keep: impl Fn(&Outbox) -> bool) -> Vec<ConnectedPeer> {
    outboxes()
        .lock()
        .map(|b| {
            b.iter()
                .filter(|(_, outbox)| keep(outbox))
                .map(|(peer_id, outbox)| ConnectedPeer {
                    peer_id: peer_id.clone(),
                    link: outbox.link,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Hand a frame from the webview's file session to one browser, on its stream.
#[tauri::command]
pub fn link_blob_send(peer_id: String, stream: u32, frame: String) -> Result<(), String> {
    queue(
        &peer_id,
        serde_json::json!({ "blob": frame, "stream": stream }),
        true,
    )
}

/// Ask one browser to open a file stream. The app never opens one itself, so the two ends
/// cannot race to (see @core/sync/transport/blob-link).
#[tauri::command]
pub fn link_blob_poke(peer_id: String) -> Result<(), String> {
    queue(&peer_id, serde_json::json!({ "blobPoke": true }), true)
}

/// The connected browsers that speak files.
#[tauri::command]
pub fn link_blob_peers() -> Vec<ConnectedPeer> {
    connected(|outbox| outbox.files)
}

/// Record what one connection speaks, and answer with what this app does. The webview is told
/// separately, once the answer is queued (see read_loop).
fn answer_caps(peer_id: &str, link: u64, caps: &[String]) -> Answer {
    let files = caps.iter().any(|c| c == CAP_FILES);
    if files {
        if let Ok(mut boxes) = outboxes().lock() {
            if let Some(outbox) = boxes.get_mut(peer_id).filter(|o| o.link == link) {
                outbox.files = true;
            }
        }
    }
    Answer {
        caps: Some(vec![CAP_FILES.to_string()]),
        ..Answer::ok()
    }
}

/// Serve application traffic over the established session until the browser goes away.
///
/// Every answer is gated on the vault being unlocked. That is the single biggest bound on
/// what a stolen pairing key is worth: it turns permanent silent access into access during
/// the windows the user was already working in. See docs/desktop-port.md.
fn serve_session(session_id: u32, root: &Path, stream: &mut ipc::Stream) -> Result<(), String> {
    // The browser's static key: stable across reconnects and distinct per install, so it is what
    // the webview addresses a peer by. Two profiles of one browser share an extension id but not
    // this, which is why nothing keys on the id.
    let peer_id = handshake::handshake_remote_static(session_id)
        .map_err(|e| format!("remote static: {e:?}"))?;
    let mut writer = ipc::try_clone(stream).map_err(|e| format!("clone stream: {e}"))?;
    let closer = ipc::try_clone(stream).map_err(|e| format!("clone stream: {e}"))?;

    let (tx, rx) = mpsc::channel::<String>();
    let link = NEXT_LINK.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut boxes) = outboxes().lock() {
        // A reconnect supersedes: the old stream is already dead or dying, and leaving its queue
        // in place would send this browser's frames into a socket nobody reads.
        boxes.insert(
            peer_id.clone(),
            Outbox {
                link,
                tx: tx.clone(),
                files: false,
                root: root.to_path_buf(),
                closer,
            },
        );
    }
    let pump = thread::spawn(move || {
        // Ends when every sender is dropped, which is the read loop finishing plus the registry
        // entry going. No separate shutdown signal to get wrong.
        for plaintext in rx {
            let Ok(sealed) = handshake::handshake_encrypt(session_id, plaintext) else {
                return;
            };
            let out = serde_json::json!({ "sealed": sealed });
            let Ok(bytes) = serde_json::to_vec(&out) else {
                return;
            };
            if write_frame(&mut writer, &bytes).is_err() {
                return;
            }
        }
    });

    // The link generation rides on every event. A browser can establish a new connection before
    // the old one notices it is dead, so "connected(new)" can reach the webview before
    // "disconnected(old)"; without a generation to compare, that stale disconnect would tear down
    // the live peer and sync would stop until the next reconnect.
    emit(
        "link-peer-connected",
        serde_json::json!({ "peerId": peer_id, "link": link }),
    );
    let result = read_loop(session_id, root, &peer_id, link, stream, &tx);

    // Deregister before dropping our sender, so nothing queues onto a link that is closing.
    if let Ok(mut boxes) = outboxes().lock() {
        // Only if it is still ours: a reconnect may have replaced it while this one was closing.
        if boxes
            .get(&peer_id)
            .is_some_and(|outbox| outbox.link == link)
        {
            boxes.remove(&peer_id);
        }
    }
    forget_page(&peer_id, link);
    drop(tx);
    let _ = pump.join();
    emit(
        "link-peer-disconnected",
        serde_json::json!({ "peerId": peer_id, "link": link }),
    );
    result
}

fn read_loop(
    session_id: u32,
    root: &Path,
    peer_id: &str,
    link: u64,
    stream: &mut ipc::Stream,
    out: &mpsc::Sender<String>,
) -> Result<(), String> {
    loop {
        let Some(frame) = read_frame(stream).map_err(|e| format!("read: {e}"))? else {
            return Ok(());
        };
        let sealed: SealedFrame =
            serde_json::from_slice(&frame).map_err(|e| format!("bad sealed frame: {e}"))?;

        let plaintext = handshake::handshake_decrypt(session_id, sealed.sealed)
            .map_err(|e| format!("decrypt: {e:?}"))?;

        // Admitted when it connected, which says nothing about now: the app may have opened
        // another vault since. One refusal, then the connection goes.
        if !pairing::admitted(root, peer_id) {
            let body = serde_json::to_string(&Answer::error(pairing::refusal(root, peer_id)))
                .map_err(|e| format!("encode answer: {e}"))?;
            let _ = out.send(body);
            return Err(NOT_LINKED.into());
        }

        // Sync frames are relayed, not answered: the webview replies in its own time, or not at
        // all. Everything else is request/response and gets exactly one answer.
        // Reported, not answered: the browser tells us where it is whenever that changes.
        if let Ok(Request::ActiveTab { hostname }) = serde_json::from_str::<Request>(&plaintext) {
            record_page(peer_id, link, hostname);
            continue;
        }
        if let Ok(Request::Sync { frame, room }) = serde_json::from_str::<Request>(&plaintext) {
            emit(
                "link-sync-frame",
                serde_json::json!({ "peerId": peer_id, "link": link, "frame": frame, "room": room }),
            );
            continue;
        }
        if let Ok(Request::Blob { stream, frame }) = serde_json::from_str::<Request>(&plaintext) {
            emit(
                "link-blob-frame",
                serde_json::json!({ "peerId": peer_id, "link": link, "stream": stream, "frame": frame }),
            );
            continue;
        }
        let request = serde_json::from_str::<Request>(&plaintext);
        let speaks_files =
            matches!(&request, Ok(Request::Caps { caps }) if caps.iter().any(|c| c == CAP_FILES));
        let answer = match request {
            // Before the lock gate in answer_for: what a connection speaks says nothing about
            // any vault, and a browser reconnecting to a locked app still needs to learn it.
            Ok(Request::Caps { caps }) => answer_caps(peer_id, link, &caps),
            Ok(Request::Query { .. } | Request::Fetch { .. })
                if !pairing::listed(root, peer_id) =>
            {
                Answer::error(PAIRING_PENDING)
            }
            // Says nothing about any vault either; the webview's sync ignores it while locked.
            Ok(Request::SyncRestart) => {
                emit(
                    "link-sync-restart",
                    serde_json::json!({ "peerId": peer_id, "link": link }),
                );
                Answer::ok()
            }
            // Listing needs no vault key, and the app may lock while the copy runs.
            Ok(Request::LinkComplete) => match pairing::complete_link(root, peer_id) {
                Ok(true) => Answer::ok(),
                Ok(false) => Answer::error("no link to complete"),
                Err(e) => Answer::error(&e),
            },
            Ok(request) => answer_for(request, peer_id),
            Err(e) => Answer::error(&format!("bad request: {e}")),
        };
        let body = serde_json::to_string(&answer).map_err(|e| format!("encode answer: {e}"))?;
        // A closed queue means the writer died; the connection is over either way.
        out.send(body).map_err(|_| "link closed".to_string())?;
        // After the answer is queued, so nothing the webview sends in response (a poke) can
        // reach the browser ahead of the answer that tells it the app speaks files.
        if speaks_files {
            emit(
                "link-blob-capable",
                serde_json::json!({ "peerId": peer_id, "link": link }),
            );
        }
    }
}

fn answer_for(request: Request, peer_id: &str) -> Answer {
    // Locked means locked, for metadata as much as for secrets: which sites you hold accounts
    // for is worth protecting on its own. SyncIdentity is the one exception, handled first,
    // because it says nothing about any vault.
    if vault_crypto::is_locked() && !matches!(request, Request::SyncIdentity) {
        return Answer::error("locked");
    }
    match request {
        // Before the lock gate below, deliberately: see the variant's comment.
        Request::SyncIdentity => {
            return match sync_identity().lock().ok().and_then(|s| s.clone()) {
                Some(public_key) => Answer {
                    identity: Some(public_key),
                    ..Answer::ok()
                },
                None => Answer::error("no identity"),
            };
        }
        Request::VaultSummary => match vault_summary_for(peer_id) {
            Some(summary) => Answer {
                summary: Some(summary),
                ..Answer::ok()
            },
            None => Answer::error("no summary"),
        },
        Request::SyncInvite => match claim_invite(peer_id) {
            Some(payload) => Answer {
                invite: Some(payload),
                ..Answer::ok()
            },
            // No invite armed. Indistinguishable from expired or already claimed on purpose:
            // all three mean the same thing to a caller, which is "ask the user again".
            None => Answer::error("no invite"),
        },
        Request::Query { hostname } => Answer {
            matches: Some(index_store::query(&hostname)),
            ..Answer::ok()
        },
        Request::Fetch { id } => match index_store::secret_for(&id) {
            Some(entry) => Answer {
                username: Some(entry.username),
                password: Some(entry.password),
                totp: entry.totp,
                ..Answer::ok()
            },
            None => Answer::error("unknown entry"),
        },
        // Both handled before this, in read_loop: relayed or recorded, not answered.
        Request::Sync { .. } => Answer::error("sync frames are not answered"),
        Request::Blob { .. } => Answer::error("file frames are not answered"),
        Request::ActiveTab { .. } => Answer::error("active-tab reports are not answered"),
        Request::Caps { .. } => Answer::error("caps are answered per link"),
        Request::SyncRestart => Answer::error("sync restarts are answered per link"),
        Request::LinkComplete => Answer::error("link completion is answered per link"),
    }
}

fn read_frame(stream: &mut ipc::Stream) -> std::io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match stream.read_exact(&mut len) {
        Ok(()) => {}
        // A clean close between frames is how a browser going away looks, not a fault.
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len);
    if len > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("frame of {len} bytes exceeds the cap"),
        ));
    }
    let mut body = vec![0u8; len as usize];
    stream.read_exact(&mut body)?;
    Ok(Some(body))
}

fn write_frame(stream: &mut ipc::Stream, body: &[u8]) -> std::io::Result<()> {
    stream.write_all(&(body.len() as u32).to_le_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn reply(stream: &mut ipc::Stream, reply: &Reply) -> std::io::Result<()> {
    let body = serde_json::to_vec(reply).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    write_frame(stream, &body)
}

/// Run one connection to the end of its handshake.
///
/// Every failure closes the connection rather than explaining itself in detail. A caller that
/// cannot complete the handshake has no business learning whether it failed because no
/// pairing was open, because the code was wrong, or because its key is not allowlisted.
fn serve(root: &Path, stream: &mut ipc::Stream) -> Result<(), String> {
    let Some(first) = read_frame(stream).map_err(|e| format!("read hello: {e}"))? else {
        return Ok(());
    };
    let hello: Hello = serde_json::from_slice(&first).map_err(|e| format!("bad hello: {e}"))?;

    let handshake = match hello {
        Hello::Hello { v, public_key } => {
            check_version(v)?;
            // Says which, so a browser no vault here knows can drop its link.
            pairing::accept_known(root, &public_key).map_err(|e| {
                let said = if e == NOT_LINKED {
                    pairing::refusal(root, &public_key)
                } else {
                    "refused"
                };
                (said, e)
            })
        }
        Hello::Link { v, label } => {
            check_version(v)?;
            pairing::accept_link(root, &label).map_err(|e| ("refused", e))
        }
    };
    let handshake = match handshake {
        Ok(h) => h,
        Err((said, e)) => {
            let _ = reply(stream, &Reply::err(said));
            return Err(e);
        }
    };

    let result = drive(root, &handshake, stream);
    pairing::close(&handshake);
    result
}

fn check_version(v: u32) -> Result<(), String> {
    if v != PROTOCOL_VERSION {
        return Err(format!("unsupported protocol version {v}"));
    }
    Ok(())
}

fn drive(
    root: &Path,
    handshake: &pairing::Handshake,
    stream: &mut ipc::Stream,
) -> Result<(), String> {
    loop {
        // A link that stops before its emoji are shown frees the window for the real browser:
        // nothing reached the user's screen, and a stray probe must not close their dialog.
        let abandon = || {
            if handshake.link_label().is_some() {
                pairing::end_link_attempt();
            }
        };
        let frame = if handshake.link_label().is_some() {
            read_frame_within(stream, Duration::from_millis(LINK_STEP_MS), || false)
        } else {
            read_frame(stream).map_err(|e| format!("read: {e}"))?
        };
        let Some(frame) = frame else {
            abandon();
            ipc::shutdown(stream);
            return Ok(());
        };
        let parsed: HandshakeFrame = serde_json::from_slice(&frame).map_err(|e| {
            abandon();
            format!("bad handshake frame: {e}")
        })?;

        let step = match pairing::read_message(handshake, &parsed.message) {
            Ok(step) => step,
            Err(e) => {
                abandon();
                let _ = reply(stream, &Reply::err("refused"));
                return Err(e);
            }
        };
        let done = step.done;
        reply(stream, &Reply::step(step.message, done)).map_err(|e| format!("write: {e}"))?;
        if done {
            if let Some(label) = handshake.link_label() {
                return confirm_link(root, handshake.session_id, stream, label);
            }
            // Authenticated from here, so the same connection carries application traffic,
            // sealed under the session the handshake just established.
            return serve_session(handshake.session_id, root, stream);
        }
    }
}

/// An emoji link waiting on both answers: the desktop's Approve and the browser's "They match".
struct PendingLink {
    /** Which link this is, so a finished one cannot clear its successor. */
    generation: u64,
    sas_hash_b64: String,
    label: String,
    answer: Option<bool>,
    /** The dialog closed: overrides any approval already given. */
    cancelled: bool,
}

static NEXT_PENDING: AtomicU64 = AtomicU64::new(1);

/// How long one emoji-link handshake message may take. Bounds how long a relaying attacker can
/// spend searching for matching emoji, and frees the window if a browser stalls.
const LINK_STEP_MS: u64 = if cfg!(test) { 300 } else { 30_000 };

/// Read one frame, giving up at `within` or once `stop` says so. The read runs on its own thread
/// because a named pipe has no read timeout; it ends when the connection closes.
fn read_frame_within(
    stream: &ipc::Stream,
    within: Duration,
    stop: impl Fn() -> bool,
) -> Option<Vec<u8>> {
    let mut reader = ipc::try_clone(stream).ok()?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(read_frame(&mut reader));
    });
    let deadline = Instant::now() + within;
    loop {
        if stop() {
            return None;
        }
        let now = Instant::now();
        if now >= deadline {
            return None;
        }
        let slice = (deadline - now).min(Duration::from_millis(50));
        match rx.recv_timeout(slice) {
            Ok(Ok(Some(frame))) => return Some(frame),
            Ok(_) => return None,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return None,
        }
    }
}

/// Whether the link with this generation is still the live one and was not cancelled.
fn link_still_wanted(generation: u64) -> bool {
    pending_link()
        .0
        .lock()
        .map(|slot| {
            slot.as_ref()
                .is_some_and(|p| p.generation == generation && !p.cancelled)
        })
        .unwrap_or(false)
}

static PENDING_LINK: OnceLock<(Mutex<Option<PendingLink>>, Condvar)> = OnceLock::new();

fn pending_link() -> &'static (Mutex<Option<PendingLink>>, Condvar) {
    PENDING_LINK.get_or_init(|| (Mutex::new(None), Condvar::new()))
}

/// What the Connect dialog shows for the link in progress, for a window that opened after it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PendingLinkView {
    pub sas_hash_b64: String,
    pub label: String,
}

/// Open the Connect dialog's window for an emoji link.
#[tauri::command]
pub fn link_window_begin() {
    pairing::begin_link_window();
}

/// The dialog closed: refuse any link in progress and drop the invite it armed.
#[tauri::command]
pub fn link_window_cancel(app: AppHandle) {
    window_cancel(crate::storage::data_dir(&app).ok().as_deref());
}

/// `link_window_cancel`, for callers without an app handle.
pub fn window_cancel(root: Option<&Path>) {
    pairing::cancel_link_window();
    let (lock, cvar) = pending_link();
    if let Ok(mut slot) = lock.lock() {
        if let Some(pending) = slot.as_mut() {
            pending.cancelled = true;
            pending.answer = Some(false);
            cvar.notify_all();
        }
    }
    clear_sync_invite(root);
}

/// The desktop user's answer to the emoji comparison.
#[tauri::command]
pub fn link_pair_answer(approved: bool) {
    let (lock, cvar) = pending_link();
    if let Ok(mut slot) = lock.lock() {
        if let Some(pending) = slot.as_mut() {
            pending.answer.get_or_insert(approved);
            cvar.notify_all();
        }
    }
}

/// The link waiting on an answer, if any.
#[tauri::command]
pub fn link_pair_pending() -> Option<PendingLinkView> {
    let slot = pending_link().0.lock().ok()?;
    slot.as_ref().map(|p| PendingLinkView {
        sas_hash_b64: p.sas_hash_b64.clone(),
        label: p.label.clone(),
    })
}

/// Wait for the desktop user's answer. No answer within the window is a refusal.
fn await_desktop_answer() -> bool {
    let (lock, cvar) = pending_link();
    let Ok(slot) = lock.lock() else {
        return false;
    };
    let wait = Duration::from_millis(pairing::LINK_WINDOW_MS);
    let Ok((slot, _)) = cvar.wait_timeout_while(slot, wait, |s| {
        s.as_ref().is_some_and(|p| p.answer.is_none())
    }) else {
        return false;
    };
    slot.as_ref().and_then(|p| p.answer).unwrap_or(false)
}

/// What the link emoji derive from: the handshake hash and both nonces. Must match
/// `linkSasMaterial` in @core/sync/link-sas byte for byte.
fn sas_material(handshake_hash: &[u8], desktop_nonce: &[u8], browser_nonce: &[u8]) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"bramble/link/sas-input/v1");
    h.update(handshake_hash);
    h.update(desktop_nonce);
    h.update(browser_nonce);
    h.finalize().to_vec()
}

/// One sealed request from the browser with this op, within the link's step deadline.
fn read_sealed_op(session_id: u32, stream: &ipc::Stream, op: &str) -> Option<serde_json::Value> {
    let frame = read_frame_within(stream, Duration::from_millis(LINK_STEP_MS), || false)?;
    let sealed = serde_json::from_slice::<SealedFrame>(&frame).ok()?;
    let plain = handshake::handshake_decrypt(session_id, sealed.sealed).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&plain).ok()?;
    (value["op"] == op).then_some(value)
}

/// The browser commits to a nonce, learns ours, then reveals its own. Neither side can pick its
/// nonce after seeing the other's, so a relay in the middle cannot make both screens' emoji
/// agree. Returns what the emoji derive from, or None when the browser broke the exchange.
fn exchange_nonces(session_id: u32, stream: &mut ipc::Stream) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use sha2::{Digest, Sha256};
    let commit = read_sealed_op(session_id, stream, "linkCommit")?["commit"]
        .as_str()
        .and_then(|c| STANDARD.decode(c).ok())?;
    let mut ours = [0u8; 32];
    getrandom::fill(&mut ours).ok()?;
    write_sealed(
        session_id,
        stream,
        serde_json::json!({ "ok": true, "nonce": STANDARD.encode(ours) }),
    )
    .ok()?;
    let theirs = read_sealed_op(session_id, stream, "linkReveal")?["nonce"]
        .as_str()
        .and_then(|n| STANDARD.decode(n).ok())?;
    if Sha256::digest(&theirs).as_slice() != commit.as_slice() {
        return None;
    }
    write_sealed(session_id, stream, serde_json::json!({ "ok": true })).ok()?;
    let hash = STANDARD
        .decode(handshake::handshake_hash(session_id).ok()?)
        .ok()?;
    Some(STANDARD.encode(sas_material(&hash, &ours, &theirs)))
}

/// Whether the browser's user said the emoji match. A closed connection is a no.
fn browser_confirms(session_id: u32, stream: &mut ipc::Stream, generation: u64) -> bool {
    let Some(frame) = read_frame_within(
        stream,
        Duration::from_millis(pairing::LINK_WINDOW_MS),
        || !link_still_wanted(generation),
    ) else {
        return false;
    };
    let Ok(sealed) = serde_json::from_slice::<SealedFrame>(&frame) else {
        return false;
    };
    let Ok(plain) = handshake::handshake_decrypt(session_id, sealed.sealed) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&plain)
        .map(|v| v["op"] == "linkConfirm")
        .unwrap_or(false)
}

fn write_sealed(
    session_id: u32,
    stream: &mut ipc::Stream,
    body: serde_json::Value,
) -> Result<(), String> {
    let sealed = handshake::handshake_encrypt(session_id, body.to_string())
        .map_err(|e| format!("seal: {e:?}"))?;
    let bytes = serde_json::to_vec(&serde_json::json!({ "sealed": sealed }))
        .map_err(|e| format!("encode: {e}"))?;
    write_frame(stream, &bytes).map_err(|e| format!("write: {e}"))
}

/// Hold a completed emoji link until both people confirm, then allowlist it and serve it.
///
/// Nothing is trusted before both answers: the desktop's Approve says the emoji on this screen
/// match, and the browser's confirmation says the same of its screen. A fake desktop can claim
/// approval to the browser, which is why the browser's own answer is required too.
fn confirm_link(
    root: &Path,
    session_id: u32,
    stream: &mut ipc::Stream,
    label: &str,
) -> Result<(), String> {
    let peer = handshake::handshake_remote_static(session_id)
        .map_err(|e| format!("remote static: {e:?}"))?;
    let Some(hash) = exchange_nonces(session_id, stream) else {
        pairing::cancel_link_window();
        let _ = write_sealed(
            session_id,
            stream,
            serde_json::json!({ "ok": false, "error": "refused" }),
        );
        ipc::shutdown(stream);
        return Ok(());
    };
    let generation = NEXT_PENDING.fetch_add(1, Ordering::Relaxed);
    {
        let (lock, _) = pending_link();
        if let Ok(mut slot) = lock.lock() {
            *slot = Some(PendingLink {
                generation,
                sas_hash_b64: hash.clone(),
                label: label.to_string(),
                answer: None,
                cancelled: false,
            });
        }
    }
    emit(
        "link-pair-pending",
        serde_json::json!({ "sasHashB64": hash, "label": label }),
    );
    bring_forward();

    let confirmed = await_desktop_answer()
        && browser_confirms(session_id, stream, generation)
        && link_still_wanted(generation);
    // Still the dialog's own link? A cancelled one, or one a newer link replaced, must not close
    // the window or clear the prompt that now belongs to someone else.
    let mut current = false;
    if let Ok(mut slot) = pending_link().0.lock() {
        if let Some(p) = slot.as_ref().filter(|p| p.generation == generation) {
            current = !p.cancelled;
            *slot = None;
        }
    }
    if !confirmed {
        if current {
            pairing::cancel_link_window();
            emit("link-pair-done", serde_json::json!({ "paired": false }));
        }
        let _ = write_sealed(
            session_id,
            stream,
            serde_json::json!({ "ok": false, "error": "refused" }),
        );
        ipc::shutdown(stream);
        return Ok(());
    }
    if !current {
        ipc::shutdown(stream);
        return Ok(());
    }
    pairing::finish_link(root, &peer, label)?;
    // Rust alone decides which browser the invite is for; the webview follows the event.
    if bind_invite(&peer) {
        emit("link-paired", serde_json::json!({ "peerId": peer }));
    }
    emit("link-pair-done", serde_json::json!({ "paired": true }));
    write_sealed(
        session_id,
        stream,
        serde_json::json!({ "ok": true, "paired": true }),
    )?;
    serve_session(session_id, root, stream)
}

/// Bind the endpoint and serve connections until the process exits.
///
/// What "bind" means, and what keeps other accounts off it, is `ipc`'s business: a socket file
/// in this directory on unix, a named pipe with a one-SID DACL on Windows.
pub fn listen(root: &Path) -> std::io::Result<()> {
    let listener = ipc::Listener::bind(root)?;

    let root = root.to_path_buf();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = match stream {
                Ok(stream) => stream,
                // Logged rather than swallowed: on Windows this is the only signal that the
                // pipe is refusing connections, and the symptom on the other side is a browser
                // link that silently never works.
                Err(e) => {
                    log::warn!("browser socket accept: {e}");
                    continue;
                }
            };
            let root = root.clone();
            // One thread per connection. There is at most a browser or two, and a handshake
            // is a handful of round trips, so a runtime would be more machinery than this
            // needs.
            thread::spawn(move || {
                if let Err(e) = serve(&root, &mut stream) {
                    // Logged, never sent: see `serve`. At warn rather than debug because
                    // this is the only place the reason exists, and a refusal the user did
                    // not expect is exactly what they will be trying to diagnose. Except a
                    // browser linked to another vault: expected, and retried every 20 s.
                    if e == NOT_LINKED {
                        log::debug!("socket connection refused: {e}");
                    } else {
                        log::warn!("socket connection refused: {e}");
                    }
                }
            });
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use vault_crypto::handshake;

    /// Drives the extension's half over a real socket. The shipped one runs this same
    /// handshake in WASM through the proxy, so the protocol exercised here is the real one.
    struct Client {
        stream: ipc::Stream,
    }

    impl Client {
        fn connect(root: &Path) -> Self {
            Self {
                stream: ipc::connect(root).expect("connect"),
            }
        }

        fn send(&mut self, value: serde_json::Value) {
            let body = serde_json::to_vec(&value).unwrap();
            self.stream
                .write_all(&(body.len() as u32).to_le_bytes())
                .unwrap();
            self.stream.write_all(&body).unwrap();
            self.stream.flush().unwrap();
        }

        fn recv(&mut self) -> serde_json::Value {
            let mut len = [0u8; 4];
            self.stream.read_exact(&mut len).unwrap();
            let mut body = vec![0u8; u32::from_le_bytes(len) as usize];
            self.stream.read_exact(&mut body).unwrap();
            serde_json::from_slice(&body).unwrap()
        }
    }

    fn started() -> TempDir {
        let dir = tempfile::tempdir().expect("temp dir");
        listen(dir.path()).expect("listen");
        dir
    }

    /// A browser that has linked, as its keypair: allowlisted and bound to any armed invite,
    /// the two steps `confirm_link` ends with once both screens have confirmed.
    /// A browser both screens confirmed, before it has the vault.
    fn pending_client(dir: &TempDir) -> (String, String) {
        // The app's identity exists before any link: accept_link sets it up for the handshake.
        pairing::public_key(dir.path()).unwrap();
        let kp = handshake::handshake_generate_keypair().unwrap();
        pairing::finish_link(dir.path(), &kp.public_key, "Chrome on Mac").unwrap();
        bind_invite(&kp.public_key);
        (kp.private_key, kp.public_key)
    }

    /// A browser whose pairing is complete.
    fn linked_client(dir: &TempDir) -> (String, String) {
        let keys = pending_client(dir);
        assert!(pairing::complete_link(dir.path(), &keys.1).unwrap());
        keys
    }

    #[test]
    fn a_linked_browser_reconnects_over_the_socket() {
        // The everyday path, and the one that runs every time a browser starts. Linking is the
        // rare event; this is the one that has to keep working.
        let _g = pairing::test_lock();
        let dir = started();
        let (client_priv, client_pub) = linked_client(&dir);

        // No dialog open: KK authenticates from the allowlist alone.
        let app_pub = pairing::public_key(dir.path()).unwrap();
        let start = handshake::handshake_start_initiator(client_priv, app_pub).unwrap();

        let mut client = Client::connect(dir.path());
        client.send(serde_json::json!({
            "kind": "hello", "v": 1, "publicKey": client_pub
        }));
        client.send(serde_json::json!({ "message": start.message }));

        let reply = client.recv();
        assert_eq!(reply["ok"], true, "reconnect refused: {reply}");
        assert_eq!(reply["done"], true, "KK should finish in one round trip");
        handshake::handshake_close(start.session_id);
    }

    /// Pair, then drive one sealed request over the session the handshake established.
    fn ask(dir: &TempDir, request: serde_json::Value) -> serde_json::Value {
        let (client_priv, client_pub) = linked_client(dir);

        let app_pub = pairing::public_key(dir.path()).unwrap();
        let start = handshake::handshake_start_initiator(client_priv, app_pub).unwrap();
        let mut client = Client::connect(dir.path());
        client.send(serde_json::json!({
            "kind": "hello", "v": 1, "publicKey": client_pub
        }));
        client.send(serde_json::json!({ "message": start.message }));
        let reply = client.recv();
        assert_eq!(reply["done"], true, "handshake did not complete");
        // KK is two messages: the responder's reply has to be fed back or this side stays
        // mid-handshake and cannot encrypt, which is invisible until something tries to.
        handshake::handshake_read(
            start.session_id,
            reply["message"].as_str().expect("msg2").to_string(),
        )
        .unwrap();

        let sealed = handshake::handshake_encrypt(start.session_id, request.to_string()).unwrap();
        client.send(serde_json::json!({ "sealed": sealed }));
        let reply = client.recv();
        let plain = handshake::handshake_decrypt(
            start.session_id,
            reply["sealed"].as_str().expect("sealed reply").to_string(),
        )
        .unwrap();
        handshake::handshake_close(start.session_id);
        serde_json::from_str(&plain).unwrap()
    }

    /// A paired client holding its session open, so both directions can be driven on one link.
    /// `ask` tears its connection down after a single request; sync needs one that stays up.
    struct Linked {
        client: Client,
        session_id: u32,
        public_key: String,
    }

    impl Linked {
        fn open(dir: &TempDir) -> Self {
            Self::connect(dir, linked_client(dir))
        }

        fn connect(dir: &TempDir, (client_priv, client_pub): (String, String)) -> Self {
            let app_pub = pairing::public_key(dir.path()).unwrap();
            let start = handshake::handshake_start_initiator(client_priv, app_pub).unwrap();
            let mut client = Client::connect(dir.path());
            client.send(serde_json::json!({
                "kind": "hello", "v": 1, "publicKey": client_pub
            }));
            client.send(serde_json::json!({ "message": start.message }));
            let reply = client.recv();
            assert_eq!(reply["done"], true, "handshake did not complete");
            handshake::handshake_read(
                start.session_id,
                reply["message"].as_str().expect("msg2").to_string(),
            )
            .unwrap();
            Self {
                client,
                session_id: start.session_id,
                public_key: client_pub,
            }
        }

        fn send(&mut self, body: serde_json::Value) {
            let sealed = handshake::handshake_encrypt(self.session_id, body.to_string()).unwrap();
            self.client.send(serde_json::json!({ "sealed": sealed }));
        }

        fn recv(&mut self) -> serde_json::Value {
            let reply = self.client.recv();
            let plain = handshake::handshake_decrypt(
                self.session_id,
                reply["sealed"].as_str().expect("sealed").to_string(),
            )
            .unwrap();
            serde_json::from_str(&plain).unwrap()
        }

        /// Wait for this link to appear in (or leave) the registry. Registration happens on the
        /// connection's own thread, so it is not ordered against the test's next statement.
        fn await_registered(&self, want: bool) {
            for _ in 0..200 {
                let listed = link_sync_peers()
                    .iter()
                    .any(|p| p.peer_id == self.public_key);
                if listed == want {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            panic!("peer registered={} never happened", want);
        }
    }

    fn invite_armed() -> bool {
        armed().lock().map(|s| s.is_some()).unwrap_or(false)
    }

    /// State the lock state this test needs. The vault is process-global, so a test that leaves
    /// it unlocked would otherwise decide whether the next one passes.
    fn unlocked() {
        vault_crypto::unlock_with_vek(vault_crypto::generate_vek().unwrap()).unwrap();
    }

    #[test]
    fn a_locked_vault_hands_out_no_invite_even_when_one_is_armed() {
        // Consistent with every other answer, and not merely defensive: enrollment sends the vault
        // itself, which needs the VEK, so an invite claimed while locked could not be completed.
        let _g = pairing::test_lock();
        let dir = started();
        unlocked();
        link_arm_sync_invite("the-invite".into(), 60_000).unwrap();
        let mut link = Linked::open(&dir);
        vault_crypto::lock();

        link.send(serde_json::json!({ "op": "syncInvite" }));
        assert_eq!(link.recv()["ok"], false);

        // And it was not spent by the refusal: unlocking and asking again works, so a lock that
        // happened to land mid-pairing costs the user a retry rather than a fresh code.
        unlocked();
        link.send(serde_json::json!({ "op": "syncInvite" }));
        assert_eq!(link.recv()["invite"], "the-invite");

        handshake::handshake_close(link.session_id);
    }

    #[test]
    fn a_browser_gets_the_sync_invite_only_while_one_is_armed() {
        // The whole point of arming: an established link authenticates a browser, and
        // authentication is not consent to hand over the vault. Pairing happened whenever it
        // happened; the invite exists only while the user is looking at a code.
        let _g = pairing::test_lock();
        let dir = started();
        unlocked();
        clear_sync_invite(None);
        let mut link = Linked::open(&dir);

        link.send(serde_json::json!({ "op": "syncInvite" }));
        assert_eq!(link.recv()["ok"], false, "answered with no invite armed");

        link_arm_sync_invite("the-invite".into(), 60_000).unwrap();
        // As if this browser had just paired in the dialog that armed it.
        bind_invite(&link.public_key);
        link.send(serde_json::json!({ "op": "syncInvite" }));
        let answer = link.recv();
        assert_eq!(answer["ok"], true, "refused an armed invite: {answer}");
        assert_eq!(answer["invite"], "the-invite");

        handshake::handshake_close(link.session_id);
    }

    #[test]
    fn an_invite_is_single_use() {
        // Two browsers can race for one code. The second must get nothing, or a code the user
        // showed once would enrol every caller that saw it.
        let _g = pairing::test_lock();
        let dir = started();
        unlocked();
        link_arm_sync_invite("the-invite".into(), 60_000).unwrap();
        let mut link = Linked::open(&dir);

        link.send(serde_json::json!({ "op": "syncInvite" }));
        assert_eq!(link.recv()["ok"], true);
        link.send(serde_json::json!({ "op": "syncInvite" }));
        assert_eq!(link.recv()["ok"], false, "the invite was claimable twice");

        handshake::handshake_close(link.session_id);
    }

    #[test]
    fn an_expired_invite_is_not_claimable() {
        let _g = pairing::test_lock();
        let dir = started();
        unlocked();
        link_arm_sync_invite("the-invite".into(), 0).unwrap();
        let mut link = Linked::open(&dir);

        link.send(serde_json::json!({ "op": "syncInvite" }));
        assert_eq!(link.recv()["ok"], false);

        handshake::handshake_close(link.session_id);
    }

    #[test]
    fn arming_again_supersedes_the_previous_invite() {
        // An abandoned invite must not stay claimable behind the current one.
        let _g = pairing::test_lock();
        let dir = started();
        unlocked();
        link_arm_sync_invite("stale".into(), 60_000).unwrap();
        link_arm_sync_invite("current".into(), 60_000).unwrap();
        let mut link = Linked::open(&dir);

        link.send(serde_json::json!({ "op": "syncInvite" }));
        assert_eq!(link.recv()["invite"], "current");
        link.send(serde_json::json!({ "op": "syncInvite" }));
        assert_eq!(link.recv()["ok"], false, "the stale invite was still there");

        handshake::handshake_close(link.session_id);
    }

    #[test]
    fn dismissing_the_dialog_disarms() {
        let _g = pairing::test_lock();
        let dir = started();
        unlocked();
        link_arm_sync_invite("the-invite".into(), 60_000).unwrap();
        clear_sync_invite(None);
        let mut link = Linked::open(&dir);

        link.send(serde_json::json!({ "op": "syncInvite" }));
        assert_eq!(link.recv()["ok"], false);

        handshake::handshake_close(link.session_id);
    }

    #[test]
    fn the_app_can_push_a_sync_frame_to_a_connected_browser() {
        // Sync is a conversation, not request/response: the app has to be able to speak first,
        // which the original strict answer-per-request loop could not do.
        let _g = pairing::test_lock();
        let dir = started();
        let mut link = Linked::open(&dir);
        link.await_registered(true);

        link_sync_send(link.public_key.clone(), "hello-from-app".into(), None).expect("push");

        assert_eq!(link.recv()["sync"], "hello-from-app");
        handshake::handshake_close(link.session_id);
    }

    /// The webview's record of the vaults on this device and the one it has open.
    fn vaults(dir: &TempDir, open: &str) {
        crate::storage::ops::set_meta(
            dir.path(),
            "vault.registry".into(),
            serde_json::json!({ "vaults": [
                { "id": "vault-a", "label": "", "createdAt": 1 },
                { "id": "vault-b", "label": "", "createdAt": 1 },
            ] }),
        )
        .unwrap();
        crate::storage::ops::set_meta(dir.path(), "active-vault".into(), serde_json::json!(open))
            .unwrap();
    }

    #[test]
    fn a_browser_linked_to_another_vault_gets_no_answers() {
        // Linked while vault A was open, connected, and then the app opened vault B. A request
        // must not be answered out of B, the vault this browser was never linked to.
        let _g = pairing::test_lock();
        let dir = started();
        vaults(&dir, "vault-a");
        let mut link = Linked::open(&dir);
        link.await_registered(true);
        github_indexed();

        vaults(&dir, "vault-b");
        link.send(serde_json::json!({ "op": "query", "hostname": "github.com" }));
        let answer = link.recv();

        assert_eq!(answer["ok"], false, "{answer}");
        assert!(!answer.to_string().contains("octocat"), "{answer}");
        link.await_registered(false);
        index_store::clear();
        vault_crypto::lock();
        handshake::handshake_close(link.session_id);
    }

    #[test]
    fn nothing_is_pushed_to_a_browser_linked_to_another_vault() {
        let _g = pairing::test_lock();
        let dir = started();
        vaults(&dir, "vault-a");
        let link = Linked::open(&dir);
        link.await_registered(true);

        vaults(&dir, "vault-b");
        assert!(link_sync_send(link.public_key.clone(), "frame".into(), None).is_err());
        handshake::handshake_close(link.session_id);
    }

    // Unix only: a Windows pipe cannot be shut from another thread (see ipc::shutdown), so there
    // the browser is cut off by the check on its next frame instead.
    #[cfg(unix)]
    #[test]
    fn opening_another_vault_closes_the_browsers_it_is_not_linked_to() {
        let _g = pairing::test_lock();
        let dir = started();
        vaults(&dir, "vault-a");
        let link = Linked::open(&dir);
        link.await_registered(true);

        vaults(&dir, "vault-b");
        vault_opened(dir.path());

        link.await_registered(false);
        handshake::handshake_close(link.session_id);
    }

    #[test]
    fn no_file_frame_reaches_a_browser_until_it_says_it_speaks_files() {
        // An extension that predates files reads any frame that is not sync or fill as the
        // answer to its pending request, so one sent to it would put the link out of step.
        let _g = pairing::test_lock();
        let dir = started();
        let mut link = Linked::open(&dir);
        link.await_registered(true);
        let peer = link.public_key.clone();

        assert!(link_blob_poke(peer.clone()).is_err());
        assert!(link_blob_send(peer.clone(), 7, "frame".into()).is_err());
        assert!(!link_blob_peers().iter().any(|p| p.peer_id == peer));

        link.send(serde_json::json!({ "op": "caps", "caps": ["files"] }));
        let answer = link.recv();
        assert_eq!(answer["ok"], true, "{answer}");
        assert_eq!(answer["caps"], serde_json::json!(["files"]));
        assert!(link_blob_peers().iter().any(|p| p.peer_id == peer));

        link_blob_send(peer.clone(), 7, "frame".into()).expect("send");
        let pushed = link.recv();
        assert_eq!(pushed["blob"], "frame");
        assert_eq!(pushed["stream"], 7);
        link_blob_poke(peer).expect("poke");
        assert_eq!(link.recv()["blobPoke"], true);
        handshake::handshake_close(link.session_id);
    }

    #[test]
    fn caps_are_answered_while_locked_and_record_nothing_unknown() {
        // A browser reconnecting to a locked app still has to learn what it speaks. Naming no
        // capability this app has records nothing, so no file frame follows.
        let _g = pairing::test_lock();
        let dir = started();
        vault_crypto::lock();
        let mut link = Linked::open(&dir);
        link.await_registered(true);

        link.send(serde_json::json!({ "op": "caps", "caps": ["teleport"] }));
        let answer = link.recv();
        assert_eq!(answer["ok"], true, "{answer}");
        assert!(link_blob_send(link.public_key.clone(), 1, "frame".into()).is_err());
        handshake::handshake_close(link.session_id);
    }

    #[test]
    fn a_sync_restart_is_answered_even_while_locked() {
        // The browser asks when its sync starts on a link that was up before it: the offer this
        // app made at connect went unheard. Answered, so the browser keeps the link rather than
        // reconnecting, which a browser that cannot open its own pipe yet has no way to do.
        let _g = pairing::test_lock();
        let dir = started();
        vault_crypto::lock();
        let mut link = Linked::open(&dir);
        link.await_registered(true);

        link.send(serde_json::json!({ "op": "syncRestart" }));
        let answer = link.recv();
        assert_eq!(answer["ok"], true, "{answer}");
        handshake::handshake_close(link.session_id);
    }

    #[test]
    fn a_link_completes_while_locked() {
        // Listing the browser needs no vault key, and the app may lock while the copy runs.
        let _g = pairing::test_lock();
        let dir = started();
        let mut link = Linked::connect(&dir, pending_client(&dir));
        link.await_registered(true);
        vault_crypto::lock();
        assert!(pairing::paired_peers(dir.path()).unwrap().is_empty());

        link.send(serde_json::json!({ "op": "linkComplete" }));
        let answer = link.recv();
        assert_eq!(answer["ok"], true, "{answer}");
        assert_eq!(pairing::paired_peers(dir.path()).unwrap().len(), 1);
        handshake::handshake_close(link.session_id);
    }

    #[test]
    fn a_link_that_is_not_pending_cannot_be_completed() {
        let _g = pairing::test_lock();
        let dir = started();
        let mut link = Linked::open(&dir);
        link.await_registered(true);

        link.send(serde_json::json!({ "op": "linkComplete" }));
        let answer = link.recv();
        assert_eq!(answer["ok"], false, "{answer}");
        assert_eq!(answer["error"], "no link to complete");
        handshake::handshake_close(link.session_id);
    }

    #[cfg(unix)]
    #[test]
    fn a_removed_browser_is_closed_and_refused_as_unlinked() {
        // Told apart from another vault being open, so the browser can drop its link.
        let _g = pairing::test_lock();
        let dir = started();
        let (client_priv, client_pub) = linked_client(&dir);
        let link = Linked::connect(&dir, (client_priv.clone(), client_pub.clone()));
        link.await_registered(true);

        assert!(pairing::forget_peer(dir.path(), &client_pub).unwrap());
        vault_opened(dir.path());
        link.await_registered(false);
        handshake::handshake_close(link.session_id);

        let app_pub = pairing::public_key(dir.path()).unwrap();
        let start = handshake::handshake_start_initiator(client_priv, app_pub).unwrap();
        let mut client = Client::connect(dir.path());
        client.send(serde_json::json!({ "kind": "hello", "v": 1, "publicKey": client_pub }));
        client.send(serde_json::json!({ "message": start.message }));
        let reply = client.recv();
        assert_eq!(reply["ok"], false, "{reply}");
        assert_eq!(reply["error"], pairing::UNLINKED);
        handshake::handshake_close(start.session_id);
    }

    #[test]
    fn sync_and_file_frames_from_the_browser_are_relayed_rather_than_answered() {
        // They go to the webview, so there is nothing to reply with. Answering anyway would put a
        // frame on the wire that the browser would mis-read as the response to its next request.
        let _g = pairing::test_lock();
        let dir = started();
        vault_crypto::unlock_with_vek(vault_crypto::generate_vek().unwrap()).unwrap();
        index_store::set(vec![]);
        let mut link = Linked::open(&dir);
        link.await_registered(true);

        link.send(serde_json::json!({ "op": "sync", "frame": "from-browser" }));
        link.send(serde_json::json!({ "op": "blob", "stream": 3, "frame": "from-browser" }));
        // The next request's answer is the proof: if either frame had produced one, this would
        // read that instead and the link would be one frame out of step from here on.
        link.send(serde_json::json!({ "op": "query", "hostname": "example.com" }));

        let answer = link.recv();
        assert_eq!(answer["ok"], true);
        assert!(answer["matches"].is_array(), "got {answer}");
        handshake::handshake_close(link.session_id);
    }

    #[test]
    fn pushing_to_a_browser_that_is_not_connected_fails_rather_than_hanging() {
        let _g = pairing::test_lock();
        let _dir = started();
        assert!(link_sync_send("not-a-peer".into(), "frame".into(), None).is_err());
    }

    #[test]
    fn a_browser_that_goes_away_stops_being_a_peer() {
        // Otherwise the webview keeps broadcasting into a queue nobody drains, and the device
        // list shows a browser that closed.
        let _g = pairing::test_lock();
        let dir = started();
        let link = Linked::open(&dir);
        link.await_registered(true);
        let public_key = link.public_key.clone();
        let session_id = link.session_id;

        drop(link); // closes the socket, as a browser shutting down does

        for _ in 0..200 {
            if !link_sync_peers().iter().any(|p| p.peer_id == public_key) {
                handshake::handshake_close(session_id);
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("peer stayed registered after disconnect");
    }

    #[test]
    fn a_query_over_the_link_returns_metadata_and_no_secret() {
        let _g = pairing::test_lock();
        let dir = started();
        vault_crypto::unlock_with_vek(vault_crypto::generate_vek().unwrap()).unwrap();
        index_store::set(vec![index_store::IndexEntry {
            id: "a".into(),
            kind: "login".into(),
            name: "GitHub".into(),
            hostnames: vec!["github.com".into()],
            username: "octocat".into(),
            password: "hunter2".into(),
            totp: None,
        }]);

        let answer = ask(
            &dir,
            serde_json::json!({ "op": "query", "hostname": "github.com" }),
        );

        assert_eq!(answer["ok"], true, "{answer}");
        assert_eq!(answer["matches"][0]["secondary"], "octocat");
        // The point of splitting query from fetch. Asserted on the wire, not on the type.
        assert!(
            !answer.to_string().contains("hunter2"),
            "a query put a password on the wire: {answer}"
        );
        index_store::clear();
        vault_crypto::lock();
    }

    #[test]
    fn a_locked_vault_answers_nothing_at_all() {
        let _g = pairing::test_lock();
        let dir = started();
        vault_crypto::lock();
        index_store::set(vec![index_store::IndexEntry {
            id: "a".into(),
            kind: "login".into(),
            name: "GitHub".into(),
            hostnames: vec!["github.com".into()],
            username: "octocat".into(),
            password: "hunter2".into(),
            totp: None,
        }]);

        let answer = ask(
            &dir,
            serde_json::json!({ "op": "query", "hostname": "github.com" }),
        );

        // Not even the metadata: which sites you hold accounts for is worth protecting, and
        // this gate is the biggest single bound on what a stolen pairing key is worth.
        assert_eq!(answer["ok"], false);
        assert_eq!(answer["error"], "locked");
        index_store::clear();
    }

    #[test]
    fn a_revoked_client_cannot_reconnect() {
        let _g = pairing::test_lock();
        let dir = started();
        let (_, client_pub) = linked_client(&dir);

        assert!(pairing::forget_peer(dir.path(), &client_pub).unwrap());

        let mut client = Client::connect(dir.path());
        client.send(serde_json::json!({
            "kind": "hello", "v": 1, "publicKey": client_pub
        }));
        assert_eq!(
            client.recv()["ok"],
            false,
            "revocation must actually revoke"
        );
    }

    #[test]
    fn a_code_pairing_attempt_is_refused() {
        // What an extension from before the emoji sends. The app offers no code any more, so
        // this gets no further than its hello, and nothing is allowlisted.
        let _g = pairing::test_lock();
        let dir = started();

        let mut client = Client::connect(dir.path());
        client.send(serde_json::json!({
            "kind": "pair", "v": 1, "label": "chrome-extension://abc"
        }));
        let mut len = [0u8; 4];
        assert!(client.stream.read_exact(&mut len).is_err());
        assert!(pairing::paired_peers(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn an_unpaired_key_is_refused() {
        let _g = pairing::test_lock();
        let dir = started();
        let stranger = handshake::handshake_generate_keypair().unwrap();

        let mut client = Client::connect(dir.path());
        client.send(serde_json::json!({
            "kind": "hello", "v": 1, "publicKey": stranger.public_key
        }));
        assert_eq!(client.recv()["ok"], false);
    }

    #[test]
    fn a_wrong_protocol_version_is_refused() {
        let _g = pairing::test_lock();
        let dir = started();

        let mut client = Client::connect(dir.path());
        client.send(serde_json::json!({ "kind": "link", "v": 99, "label": "future" }));
        // The connection closes; the point is that it does not proceed into a handshake.
        let mut len = [0u8; 4];
        assert!(client.stream.read_exact(&mut len).is_err());
    }

    #[test]
    fn an_oversized_frame_is_refused_without_allocating_it() {
        let _g = pairing::test_lock();
        let dir = started();
        let mut client = Client::connect(dir.path());

        // Claim a gigabyte and send nothing. A listener that trusted the header would sit on
        // a 1 GB buffer waiting for bytes that never arrive.
        client
            .stream
            .write_all(&(1024u32 * 1024 * 1024).to_le_bytes())
            .unwrap();
        client.stream.flush().unwrap();

        let mut len = [0u8; 4];
        assert!(client.stream.read_exact(&mut len).is_err());
    }

    /// Both of these are about the socket FILE, which only unix has. Windows binds a named
    /// pipe instead, and what stands in for them there is asserted in `ipc`.
    #[cfg(unix)]
    #[test]
    fn the_socket_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let _g = pairing::test_lock();
        let dir = started();
        let mode = std::fs::metadata(ipc::unix_endpoint(dir.path()))
            .unwrap()
            .permissions()
            .mode();
        // Keeps other accounts out. Says nothing about processes running as this user, which
        // is what the handshake is for.
        assert_eq!(mode & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_socket_file_does_not_block_startup() {
        let _g = pairing::test_lock();
        let dir = tempfile::tempdir().unwrap();
        // What a crash leaves behind.
        std::fs::write(ipc::unix_endpoint(dir.path()), b"stale").unwrap();
        listen(dir.path()).expect("should replace the stale socket");
    }

    /// Wait until the most recent reporter is `want` (peer id and page), or nobody reported.
    fn await_reported(want: Option<(&str, &str)>) {
        for _ in 0..200 {
            let now = reported_page();
            if now.as_ref().map(|(p, h)| (p.as_str(), h.as_str())) == want {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!(
            "reported page never became {want:?}, is {:?}",
            reported_page()
        );
    }

    #[test]
    fn each_browser_reports_its_own_page() {
        let _g = pairing::test_lock();
        let dir = started();
        let mut a = Linked::open(&dir);
        let mut b = Linked::open(&dir);
        a.send(serde_json::json!({ "op": "activeTab", "hostname": "a.com" }));
        await_reported(Some((&a.public_key, "a.com")));
        b.send(serde_json::json!({ "op": "activeTab", "hostname": "b.com" }));
        await_reported(Some((&b.public_key, "b.com")));

        let (b_session, a_key) = (b.session_id, a.public_key.clone());
        drop(b);
        await_reported(Some((&a_key, "a.com")));
        handshake::handshake_close(b_session);
        handshake::handshake_close(a.session_id);
    }

    #[test]
    fn an_empty_report_clears_only_that_browser() {
        let _g = pairing::test_lock();
        let dir = started();
        let mut a = Linked::open(&dir);
        let mut b = Linked::open(&dir);
        a.send(serde_json::json!({ "op": "activeTab", "hostname": "a.com" }));
        await_reported(Some((&a.public_key, "a.com")));
        b.send(serde_json::json!({ "op": "activeTab", "hostname": "b.com" }));
        await_reported(Some((&b.public_key, "b.com")));

        b.send(serde_json::json!({ "op": "activeTab", "hostname": "" }));
        await_reported(Some((&a.public_key, "a.com")));
        handshake::handshake_close(a.session_id);
        handshake::handshake_close(b.session_id);
    }

    fn github_indexed() {
        unlocked();
        index_store::set(vec![index_store::IndexEntry {
            id: "gh".into(),
            kind: "login".into(),
            name: "GitHub".into(),
            hostnames: vec!["github.com".into()],
            username: "octocat".into(),
            password: "hunter2".into(),
            totp: None,
        }]);
    }

    /// The next frame this browser gets, proving nothing was queued for it before `marker`.
    fn next_after_marker(link: &mut Linked, marker: &str) -> serde_json::Value {
        link_sync_send(link.public_key.clone(), marker.into(), None).expect("marker");
        link.recv()
    }

    #[test]
    fn a_pending_browser_gets_no_credentials_until_its_pairing_is_complete() {
        // Served for the claim and the copy only: a pairing abandoned part way had nothing else.
        let _g = pairing::test_lock();
        let dir = started();
        github_indexed();
        let mut link = Linked::connect(&dir, pending_client(&dir));
        link.await_registered(true);

        link.send(serde_json::json!({ "op": "query", "hostname": "github.com" }));
        let refused = link.recv();
        assert_eq!(refused["ok"], false, "{refused}");
        link.send(serde_json::json!({ "op": "fetch", "id": "gh" }));
        assert_eq!(link.recv()["ok"], false);

        link.send(serde_json::json!({ "op": "linkComplete" }));
        assert_eq!(link.recv()["ok"], true);
        link.send(serde_json::json!({ "op": "fetch", "id": "gh" }));
        assert_eq!(link.recv()["password"], "hunter2");
        index_store::clear();
        vault_crypto::lock();
        handshake::handshake_close(link.session_id);
    }

    #[test]
    fn no_panel_fill_reaches_a_browser_whose_pairing_is_pending() {
        let _g = pairing::test_lock();
        let dir = started();
        github_indexed();
        let mut link = Linked::connect(&dir, pending_client(&dir));
        link.await_registered(true);
        link.send(serde_json::json!({ "op": "activeTab", "hostname": "github.com" }));
        await_reported(Some((&link.public_key, "github.com")));

        assert!(spotlight_request_fill("gh".into()).is_err());
        assert_eq!(next_after_marker(&mut link, "marker")["sync"], "marker");
        index_store::clear();
        vault_crypto::lock();
        handshake::handshake_close(link.session_id);
    }

    #[test]
    fn a_fill_reaches_only_the_reporting_browser() {
        let _g = pairing::test_lock();
        let dir = started();
        github_indexed();
        let mut a = Linked::open(&dir);
        let mut b = Linked::open(&dir);
        b.await_registered(true);
        a.send(serde_json::json!({ "op": "activeTab", "hostname": "github.com" }));
        await_reported(Some((&a.public_key, "github.com")));

        spotlight_request_fill("gh".into()).expect("fill");

        assert_eq!(a.recv()["fill"]["password"], "hunter2");
        assert_eq!(next_after_marker(&mut b, "marker")["sync"], "marker");
        index_store::clear();
        vault_crypto::lock();
        handshake::handshake_close(a.session_id);
        handshake::handshake_close(b.session_id);
    }

    #[test]
    fn no_reported_page_means_no_fill() {
        let _g = pairing::test_lock();
        let dir = started();
        github_indexed();
        let mut a = Linked::open(&dir);
        let mut b = Linked::open(&dir);
        a.await_registered(true);
        b.await_registered(true);
        await_reported(None);

        assert!(spotlight_request_fill("gh".into()).is_err());

        assert_eq!(next_after_marker(&mut a, "ma")["sync"], "ma");
        assert_eq!(next_after_marker(&mut b, "mb")["sync"], "mb");
        index_store::clear();
        vault_crypto::lock();
        handshake::handshake_close(a.session_id);
        handshake::handshake_close(b.session_id);
    }

    #[test]
    fn the_hostname_check_uses_the_target_browser_page() {
        let _g = pairing::test_lock();
        let dir = started();
        github_indexed();
        let mut a = Linked::open(&dir);
        a.send(serde_json::json!({ "op": "activeTab", "hostname": "evil.com" }));
        await_reported(Some((&a.public_key, "evil.com")));

        assert_eq!(
            spotlight_request_fill("gh".into()),
            Err("that entry is not for evil.com".to_string())
        );
        assert_eq!(next_after_marker(&mut a, "m")["sync"], "m");
        index_store::clear();
        vault_crypto::lock();
        handshake::handshake_close(a.session_id);
    }

    #[test]
    fn a_pushed_sync_frame_carries_its_room() {
        let _g = pairing::test_lock();
        let dir = started();
        let mut link = Linked::open(&dir);
        link.await_registered(true);

        link_sync_send(link.public_key.clone(), "e".into(), Some("enroll".into())).expect("push");
        let tagged = link.recv();
        assert_eq!(tagged["sync"], "e");
        assert_eq!(tagged["room"], "enroll");

        link_sync_send(link.public_key.clone(), "s".into(), None).expect("push");
        let plain = link.recv();
        assert_eq!(plain["sync"], "s");
        assert!(
            plain.get("room").is_none(),
            "an untagged frame grew a room: {plain}"
        );
        handshake::handshake_close(link.session_id);
    }

    #[test]
    fn an_unbound_invite_is_claimable_by_nobody() {
        let _g = pairing::test_lock();
        let dir = started();
        unlocked();
        let mut a = Linked::open(&dir);
        // Armed after A paired, so no pairing in this dialog has bound it.
        link_arm_sync_invite("the-invite".into(), 60_000).unwrap();
        a.send(serde_json::json!({ "op": "syncInvite" }));
        assert_eq!(a.recv()["error"], "no invite");
        clear_sync_invite(None);
        vault_crypto::lock();
        handshake::handshake_close(a.session_id);
    }

    #[test]
    fn only_the_bound_browser_can_claim() {
        let _g = pairing::test_lock();
        let dir = started();
        unlocked();
        link_arm_sync_invite("the-invite".into(), 60_000).unwrap();
        let mut a = Linked::open(&dir); // pairs while armed: bound to A
        let mut b = Linked::open(&dir); // a later pairing does not move it

        b.send(serde_json::json!({ "op": "syncInvite" }));
        assert_eq!(b.recv()["error"], "no invite");
        a.send(serde_json::json!({ "op": "syncInvite" }));
        assert_eq!(a.recv()["invite"], "the-invite");
        a.send(serde_json::json!({ "op": "syncInvite" }));
        assert_eq!(a.recv()["error"], "no invite");
        vault_crypto::lock();
        handshake::handshake_close(a.session_id);
        handshake::handshake_close(b.session_id);
    }

    /// A browser that has run the emoji link handshake and is waiting on both confirmations.
    struct LinkClient {
        client: Client,
        session_id: u32,
        public_key: String,
        /// What its emoji derive from, computed on the browser's side.
        material: String,
    }

    fn b64(bytes: &[u8]) -> String {
        use base64::{engine::general_purpose::STANDARD, Engine};
        STANDARD.encode(bytes)
    }

    fn sha(bytes: &[u8]) -> Vec<u8> {
        use sha2::{Digest, Sha256};
        Sha256::digest(bytes).to_vec()
    }

    impl LinkClient {
        fn start(dir: &TempDir) -> Result<Self, serde_json::Value> {
            let kp = handshake::handshake_generate_keypair().unwrap();
            let start = handshake::handshake_link_initiator(kp.private_key.clone()).unwrap();
            let mut client = Client::connect(dir.path());
            client.send(serde_json::json!({ "kind": "link", "v": 1, "label": "Chrome on Mac" }));
            client.send(serde_json::json!({ "message": start.message }));
            let reply = client.recv();
            if reply["ok"] != true {
                return Err(reply);
            }
            let msg2 = reply["message"].as_str().expect("msg2").to_string();
            let msg3 = handshake::handshake_read(start.session_id, msg2)
                .unwrap()
                .message
                .expect("msg3");
            client.send(serde_json::json!({ "message": msg3 }));
            assert_eq!(client.recv()["done"], true);
            let mut this = Self {
                client,
                session_id: start.session_id,
                public_key: kp.public_key,
                material: String::new(),
            };
            // Commit to a nonce, learn the app's, then reveal ours.
            let nb = [7u8; 32];
            this.send(serde_json::json!({ "op": "linkCommit", "commit": b64(&sha(&nb)) }));
            let answer = this.recv();
            let nd = answer["nonce"].as_str().ok_or(answer.clone())?.to_string();
            this.send(serde_json::json!({ "op": "linkReveal", "nonce": b64(&nb) }));
            let ack = this.recv();
            if ack["ok"] != true {
                return Err(ack);
            }
            use base64::{engine::general_purpose::STANDARD, Engine};
            let h = STANDARD
                .decode(handshake::handshake_hash(this.session_id).unwrap())
                .unwrap();
            this.material = b64(&sas_material(&h, &STANDARD.decode(nd).unwrap(), &nb));
            Ok(this)
        }

        fn send(&mut self, body: serde_json::Value) {
            let sealed = handshake::handshake_encrypt(self.session_id, body.to_string()).unwrap();
            self.client.send(serde_json::json!({ "sealed": sealed }));
        }

        fn recv(&mut self) -> serde_json::Value {
            let reply = self.client.recv();
            let plain = handshake::handshake_decrypt(
                self.session_id,
                reply["sealed"].as_str().expect("sealed").to_string(),
            )
            .unwrap();
            serde_json::from_str(&plain).unwrap()
        }
    }

    fn await_pending(want: bool) {
        for _ in 0..300 {
            if link_pair_pending().is_some() == want {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("pending link never became {want}");
    }

    #[test]
    fn a_link_hello_with_no_window_open_is_refused() {
        let _g = pairing::test_lock();
        let dir = started();
        window_cancel(None);
        let refused = LinkClient::start(&dir).err().expect("refused");
        assert_eq!(refused["ok"], false);
    }

    #[test]
    fn a_second_link_while_one_is_pending_is_refused() {
        let _g = pairing::test_lock();
        let dir = started();
        link_window_begin();
        let first = LinkClient::start(&dir).expect("first link");
        await_pending(true);
        assert_eq!(
            LinkClient::start(&dir).err().expect("second refused")["ok"],
            false
        );
        window_cancel(None);
        handshake::handshake_close(first.session_id);
    }

    #[test]
    fn nothing_is_allowlisted_until_both_sides_confirm() {
        let _g = pairing::test_lock();
        let dir = started();

        // The desktop approves, the browser walks away.
        link_window_begin();
        let a = LinkClient::start(&dir).expect("link");
        await_pending(true);
        link_pair_answer(true);
        let a_key = a.public_key.clone();
        drop(a);
        await_pending(false);
        assert!(!pairing::paired_peers(dir.path())
            .unwrap()
            .iter()
            .any(|p| p.public_key == a_key));

        // The browser confirms, the desktop refuses.
        link_window_begin();
        let mut b = LinkClient::start(&dir).expect("link");
        await_pending(true);
        b.send(serde_json::json!({ "op": "linkConfirm" }));
        link_pair_answer(false);
        assert_eq!(b.recv()["ok"], false);
        assert!(!pairing::paired_peers(dir.path())
            .unwrap()
            .iter()
            .any(|p| p.public_key == b.public_key));
        handshake::handshake_close(b.session_id);
    }

    #[test]
    fn cancelling_the_window_drops_the_pending_link_and_the_invite() {
        let _g = pairing::test_lock();
        let dir = started();
        link_arm_sync_invite("the-invite".into(), 60_000).unwrap();
        link_window_begin();
        let mut a = LinkClient::start(&dir).expect("link");
        await_pending(true);
        a.send(serde_json::json!({ "op": "linkConfirm" }));

        window_cancel(None);

        assert_eq!(a.recv()["ok"], false);
        assert!(!pairing::paired_peers(dir.path())
            .unwrap()
            .iter()
            .any(|p| p.public_key == a.public_key));
        assert!(!invite_armed());
        handshake::handshake_close(a.session_id);
    }

    #[test]
    fn a_confirmed_link_claims_the_armed_invite_and_is_listed_once_complete() {
        let _g = pairing::test_lock();
        let dir = started();
        unlocked();
        link_arm_sync_invite("the-invite".into(), 60_000).unwrap();
        link_window_begin();
        let mut a = LinkClient::start(&dir).expect("link");
        await_pending(true);
        a.send(serde_json::json!({ "op": "linkConfirm" }));
        link_pair_answer(true);

        let done = a.recv();
        assert_eq!(done["ok"], true, "{done}");
        assert_eq!(done["paired"], true);
        let listed = |dir: &TempDir, key: &str| {
            pairing::paired_peers(dir.path())
                .unwrap()
                .iter()
                .any(|p| p.public_key == key)
        };
        // Not before the browser holds the vault: a pairing is never half made.
        assert!(!listed(&dir, &a.public_key));
        a.send(serde_json::json!({ "op": "syncInvite" }));
        assert_eq!(a.recv()["invite"], "the-invite");

        a.send(serde_json::json!({ "op": "linkComplete" }));
        assert_eq!(a.recv()["ok"], true);
        assert!(listed(&dir, &a.public_key));
        vault_crypto::lock();
        handshake::handshake_close(a.session_id);
    }

    #[test]
    fn the_pending_link_shows_the_browsers_handshake_hash() {
        let _g = pairing::test_lock();
        let dir = started();
        link_window_begin();
        let a = LinkClient::start(&dir).expect("link");
        await_pending(true);
        let pending = link_pair_pending().unwrap();
        assert_eq!(pending.sas_hash_b64, a.material);
        assert_eq!(pending.label, "Chrome on Mac");
        window_cancel(None);
        handshake::handshake_close(a.session_id);
    }

    fn summary() -> VaultSummary {
        VaultSummary {
            name: "Home".into(),
            empty: false,
            entries: 380,
        }
    }

    #[test]
    fn the_summary_goes_only_to_the_bound_browser() {
        let _g = pairing::test_lock();
        let dir = started();
        unlocked();
        link_set_vault_summary(Some(summary()));
        link_arm_sync_invite("the-invite".into(), 60_000).unwrap();
        let mut a = Linked::open(&dir); // bound
        let mut b = Linked::open(&dir);

        a.send(serde_json::json!({ "op": "vaultSummary" }));
        let got = a.recv();
        assert_eq!(got["summary"]["name"], "Home", "{got}");
        assert_eq!(got["summary"]["entries"], 380);
        b.send(serde_json::json!({ "op": "vaultSummary" }));
        assert_eq!(b.recv()["ok"], false);

        clear_sync_invite(None);
        link_set_vault_summary(None);
        vault_crypto::lock();
        handshake::handshake_close(a.session_id);
        handshake::handshake_close(b.session_id);
    }

    #[test]
    fn no_summary_while_locked() {
        let _g = pairing::test_lock();
        let dir = started();
        link_set_vault_summary(Some(summary()));
        link_arm_sync_invite("the-invite".into(), 60_000).unwrap();
        let mut a = Linked::open(&dir);
        vault_crypto::lock();

        a.send(serde_json::json!({ "op": "vaultSummary" }));
        assert_eq!(a.recv()["ok"], false);
        clear_sync_invite(None);
        link_set_vault_summary(None);
        handshake::handshake_close(a.session_id);
    }

    #[test]
    fn approving_then_closing_the_dialog_links_nothing_even_if_the_browser_confirms_later() {
        let _g = pairing::test_lock();
        let dir = started();
        link_window_begin();
        let mut a = LinkClient::start(&dir).expect("link");
        await_pending(true);
        link_pair_answer(true);
        window_cancel(None);

        a.send(serde_json::json!({ "op": "linkConfirm" }));
        assert_eq!(a.recv()["ok"], false);
        assert!(!pairing::paired_peers(dir.path())
            .unwrap()
            .iter()
            .any(|p| p.public_key == a.public_key));
        handshake::handshake_close(a.session_id);
    }

    #[test]
    fn a_cancelled_link_does_not_touch_the_next_one() {
        let _g = pairing::test_lock();
        let dir = started();
        // A: approved here, then the dialog closes while A's browser has not answered yet.
        link_window_begin();
        let mut a = LinkClient::start(&dir).expect("link");
        await_pending(true);
        link_pair_answer(true);
        window_cancel(None);

        // B: a new dialog and a new link, waiting on its own answers.
        link_window_begin();
        let b = LinkClient::start(&dir).expect("second link");
        await_pending(true);

        // A's browser says "They match" late. It must not clear B's prompt or be allowlisted.
        // The app may already have closed A's connection, so the send itself may fail.
        let sealed = handshake::handshake_encrypt(
            a.session_id,
            serde_json::json!({ "op": "linkConfirm" }).to_string(),
        )
        .unwrap();
        let body = serde_json::to_vec(&serde_json::json!({ "sealed": sealed })).unwrap();
        let _ = a
            .client
            .stream
            .write_all(&(body.len() as u32).to_le_bytes())
            .and_then(|_| a.client.stream.write_all(&body));
        std::thread::sleep(std::time::Duration::from_millis(200));
        let pending = link_pair_pending().expect("B still pending");
        assert_eq!(pending.sas_hash_b64, b.material);
        assert!(!pairing::paired_peers(dir.path())
            .unwrap()
            .iter()
            .any(|p| p.public_key == a.public_key));
        window_cancel(None);
        handshake::handshake_close(a.session_id);
        handshake::handshake_close(b.session_id);
    }

    #[test]
    fn a_link_handshake_that_stalls_is_dropped() {
        let _g = pairing::test_lock();
        let dir = started();
        link_window_begin();
        let mut client = Client::connect(dir.path());
        client.send(serde_json::json!({ "kind": "link", "v": 1, "label": "slow" }));
        // No first message. The app must not wait forever on it.
        let mut len = [0u8; 4];
        let started_at = std::time::Instant::now();
        let read = client.stream.read_exact(&mut len);
        assert!(started_at.elapsed() < std::time::Duration::from_secs(5));
        // Either a refusal frame or a closed socket; never a hang.
        let _ = read;
        window_cancel(None);
    }

    #[test]
    fn sas_material_matches_the_browser() {
        // The same vector is asserted in @core/sync/link-sas.test.ts.
        assert_eq!(
            b64(&sas_material(&[1; 32], &[2; 32], &[3; 32])),
            "S8naVfRk7bIlPFMxZJojFyQc+1fyQSEaCA2PzZ4RjDs="
        );
    }

    #[test]
    fn a_browser_that_reveals_another_nonce_is_refused() {
        let _g = pairing::test_lock();
        let dir = started();
        link_window_begin();
        let kp = handshake::handshake_generate_keypair().unwrap();
        let start = handshake::handshake_link_initiator(kp.private_key.clone()).unwrap();
        let mut client = Client::connect(dir.path());
        client.send(serde_json::json!({ "kind": "link", "v": 1, "label": "liar" }));
        client.send(serde_json::json!({ "message": start.message }));
        let reply = client.recv();
        let msg3 =
            handshake::handshake_read(start.session_id, reply["message"].as_str().unwrap().into())
                .unwrap()
                .message
                .unwrap();
        client.send(serde_json::json!({ "message": msg3 }));
        assert_eq!(client.recv()["done"], true);
        let mut link = LinkClient {
            client,
            session_id: start.session_id,
            public_key: kp.public_key,
            material: String::new(),
        };
        link.send(serde_json::json!({ "op": "linkCommit", "commit": b64(&sha(&[1; 32])) }));
        assert!(link.recv()["nonce"].is_string());
        link.send(serde_json::json!({ "op": "linkReveal", "nonce": b64(&[2; 32]) }));
        assert_eq!(link.recv()["ok"], false);
        assert!(link_pair_pending().is_none());
        handshake::handshake_close(link.session_id);
    }

    #[test]
    fn a_malformed_link_attempt_leaves_the_window_open() {
        let _g = pairing::test_lock();
        let dir = started();
        link_window_begin();
        let mut probe = Client::connect(dir.path());
        probe.send(serde_json::json!({ "kind": "link", "v": 1, "label": "probe" }));
        probe.send(serde_json::json!({ "message": "bm90IGEgaGFuZHNoYWtl" }));
        let _ = probe.recv();

        // Nothing reached the user's screen, so the dialog still accepts the real browser.
        let real = LinkClient::start(&dir).expect("window still open");
        window_cancel(None);
        handshake::handshake_close(real.session_id);
    }

    #[test]
    fn only_the_first_pairing_binds_the_invite() {
        let _g = pairing::test_lock();
        link_arm_sync_invite("the-invite".into(), 60_000).unwrap();
        assert!(bind_invite("first"));
        assert!(!bind_invite("second"));
        clear_sync_invite(None);
        assert!(!bind_invite("third"));
    }

    #[test]
    fn no_summary_after_the_invite_expires() {
        let _g = pairing::test_lock();
        let dir = started();
        unlocked();
        link_set_vault_summary(Some(summary()));
        link_arm_sync_invite("the-invite".into(), 1).unwrap();
        let mut a = Linked::open(&dir);
        bind_invite(&a.public_key);
        std::thread::sleep(std::time::Duration::from_millis(5));

        a.send(serde_json::json!({ "op": "vaultSummary" }));
        assert_eq!(a.recv()["ok"], false);
        clear_sync_invite(None);
        link_set_vault_summary(None);
        vault_crypto::lock();
        handshake::handshake_close(a.session_id);
    }
}
