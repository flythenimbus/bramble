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
    fs,
    io::{Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use vault_crypto::handshake;

use crate::{index_store, pairing};

/// Chrome caps a native-messaging frame at 1 MB. Nothing this protocol carries comes near it,
/// so a larger frame is a bug or an attempt to exhaust memory, not a big credential.
const MAX_FRAME: u32 = 1024 * 1024;

/// Wire protocol version. Present so a future extension talking to an older app fails with
/// something legible rather than a parse error deep in a handshake.
const PROTOCOL_VERSION: u32 = 1;

pub fn socket_path(root: &Path) -> PathBuf {
    root.join(crate::socket_addr::SOCKET_NAME)
}

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
    /// First contact: complete a pairing using the code the user is looking at.
    Pair {
        v: u32,
        /// The extension id the caller claims. Attacker-assertable, so it is stored for the
        /// user to read and never trusted for a decision.
        label: String,
    },
    /// An established browser reconnecting, identified by its allowlisted static key.
    Hello { v: u32, public_key: String },
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
    /// This app's sync device public key, so a browser can work out whether the vault it is
    /// looking at is one this app shares.
    ///
    /// Answered whether or not the vault is locked, unlike everything else here, and that is
    /// safe rather than an oversight: the key identifies this DEVICE, not any vault, and it is
    /// published in the roster to every group member already. Nothing about which vault is open
    /// leaves the app; the browser compares it against its own rosters and draws its own
    /// conclusion.
    SyncIdentity,
    /// One frame of device sync, on its way to the webview that runs the sync host.
    ///
    /// Not request/response like the other two: sync is a conversation, and either side speaks
    /// first. The frame is already sealed under sync's OWN Noise session, keyed by the two
    /// devices' roster identities, so this layer relays it without being able to read it. That
    /// is Noise inside Noise, deliberately: the outer session authenticates this browser
    /// INSTALL to this app, the inner one authenticates a roster DEVICE to the group, and only
    /// the inner identity is the one revocation acts on. See docs/desktop-port.md.
    Sync { frame: String },
}

#[derive(Serialize)]
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
    /// Set for a fetch, and only then.
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    totp: Option<String>,
}

impl Answer {
    fn error(msg: &str) -> Self {
        Self {
            ok: false,
            error: Some(msg.to_string()),
            matches: None,
            invite: None,
            identity: None,
            username: None,
            password: None,
            totp: None,
        }
    }
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
    });
    Ok(())
}

/// Disarm, for a dialog the user closed. Dismissing is a refusal.
#[tauri::command]
pub fn link_clear_sync_invite() {
    if let Ok(mut slot) = armed().lock() {
        *slot = None;
    }
}

/// Take the armed invite, if there is a live one. Single-use: claiming it disarms it, so a second
/// browser racing for the same code gets nothing.
fn claim_invite() -> Option<String> {
    let mut slot = armed().lock().ok()?;
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
static OUTBOXES: OnceLock<Mutex<HashMap<String, (u64, mpsc::Sender<String>)>>> = OnceLock::new();
static NEXT_LINK: AtomicU64 = AtomicU64::new(1);

fn outboxes() -> &'static Mutex<HashMap<String, (u64, mpsc::Sender<String>)>> {
    OUTBOXES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Give the socket a window to notify. Separate from `listen` because the link works without
/// one: a browser can be connected and answering fills while no window is open, and the tests
/// exercise the socket with no app at all.
pub fn attach(app: AppHandle) {
    let _ = APP.set(app);
}

fn emit(event: &str, payload: serde_json::Value) {
    if let Some(app) = APP.get() {
        let _ = app.emit(event, payload);
    }
}

/// Hand a frame from the webview's sync host to one browser. Errors when that browser is not
/// connected, which is ordinary: a peer that went away is not a failure of the caller.
#[tauri::command]
pub fn link_sync_send(peer_id: String, frame: String) -> Result<(), String> {
    let queued = {
        let boxes = outboxes().lock().map_err(|_| "outbox lock poisoned")?;
        match boxes.get(&peer_id) {
            Some((_, tx)) => tx
                .send(serde_json::json!({ "sync": frame }).to_string())
                .is_ok(),
            None => false,
        }
    };
    if queued {
        Ok(())
    } else {
        Err("no such peer".into())
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
    outboxes()
        .lock()
        .map(|b| {
            b.iter()
                .map(|(peer_id, (link, _))| ConnectedPeer {
                    peer_id: peer_id.clone(),
                    link: *link,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Serve application traffic over the established session until the browser goes away.
///
/// Every answer is gated on the vault being unlocked. That is the single biggest bound on
/// what a stolen pairing key is worth: it turns permanent silent access into access during
/// the windows the user was already working in. See docs/desktop-port.md.
fn serve_session(session_id: u32, stream: &mut UnixStream) -> Result<(), String> {
    // The browser's static key: stable across reconnects and distinct per install, so it is what
    // the webview addresses a peer by. Two profiles of one browser share an extension id but not
    // this, which is why nothing keys on the id.
    let peer_id = handshake::handshake_remote_static(session_id)
        .map_err(|e| format!("remote static: {e:?}"))?;
    let mut writer = stream
        .try_clone()
        .map_err(|e| format!("clone stream: {e}"))?;

    let (tx, rx) = mpsc::channel::<String>();
    let link = NEXT_LINK.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut boxes) = outboxes().lock() {
        // A reconnect supersedes: the old stream is already dead or dying, and leaving its queue
        // in place would send this browser's frames into a socket nobody reads.
        boxes.insert(peer_id.clone(), (link, tx.clone()));
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
    let result = read_loop(session_id, &peer_id, link, stream, &tx);

    // Deregister before dropping our sender, so nothing queues onto a link that is closing.
    if let Ok(mut boxes) = outboxes().lock() {
        // Only if it is still ours: a reconnect may have replaced it while this one was closing.
        if boxes.get(&peer_id).is_some_and(|(held, _)| *held == link) {
            boxes.remove(&peer_id);
        }
    }
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
    peer_id: &str,
    link: u64,
    stream: &mut UnixStream,
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

        // Sync frames are relayed, not answered: the webview replies in its own time, or not at
        // all. Everything else is request/response and gets exactly one answer.
        if let Ok(Request::Sync { frame }) = serde_json::from_str::<Request>(&plaintext) {
            emit(
                "link-sync-frame",
                serde_json::json!({ "peerId": peer_id, "link": link, "frame": frame }),
            );
            continue;
        }
        let answer = match serde_json::from_str::<Request>(&plaintext) {
            Ok(request) => answer_for(request),
            Err(e) => Answer::error(&format!("bad request: {e}")),
        };
        let body = serde_json::to_string(&answer).map_err(|e| format!("encode answer: {e}"))?;
        // A closed queue means the writer died; the connection is over either way.
        out.send(body).map_err(|_| "link closed".to_string())?;
    }
}

fn answer_for(request: Request) -> Answer {
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
                    ok: true,
                    error: None,
                    matches: None,
                    invite: None,
                    identity: Some(public_key),
                    username: None,
                    password: None,
                    totp: None,
                },
                None => Answer::error("no identity"),
            };
        }
        Request::SyncInvite => match claim_invite() {
            Some(payload) => Answer {
                ok: true,
                error: None,
                matches: None,
                invite: Some(payload),
                identity: None,
                username: None,
                password: None,
                totp: None,
            },
            // No invite armed. Indistinguishable from expired or already claimed on purpose:
            // all three mean the same thing to a caller, which is "ask the user again".
            None => Answer::error("no invite"),
        },
        Request::Query { hostname } => Answer {
            ok: true,
            error: None,
            matches: Some(index_store::query(&hostname)),
            invite: None,
            identity: None,
            username: None,
            password: None,
            totp: None,
        },
        Request::Fetch { id } => match index_store::secret_for(&id) {
            Some(entry) => Answer {
                ok: true,
                error: None,
                matches: None,
                invite: None,
                identity: None,
                username: Some(entry.username),
                password: Some(entry.password),
                totp: entry.totp,
            },
            None => Answer::error("unknown entry"),
        },
        // Handled before this, in read_loop: sync is relayed to the webview, not answered here.
        Request::Sync { .. } => Answer::error("sync frames are not answered"),
    }
}

fn read_frame(stream: &mut UnixStream) -> std::io::Result<Option<Vec<u8>>> {
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

fn write_frame(stream: &mut UnixStream, body: &[u8]) -> std::io::Result<()> {
    stream.write_all(&(body.len() as u32).to_le_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn reply(stream: &mut UnixStream, reply: &Reply) -> std::io::Result<()> {
    let body = serde_json::to_vec(reply).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    write_frame(stream, &body)
}

/// Run one connection to the end of its handshake.
///
/// Every failure closes the connection rather than explaining itself in detail. A caller that
/// cannot complete the handshake has no business learning whether it failed because no
/// pairing was open, because the code was wrong, or because its key is not allowlisted.
fn serve(root: &Path, stream: &mut UnixStream) -> Result<(), String> {
    let Some(first) = read_frame(stream).map_err(|e| format!("read hello: {e}"))? else {
        return Ok(());
    };
    let hello: Hello = serde_json::from_slice(&first).map_err(|e| format!("bad hello: {e}"))?;

    let handshake = match hello {
        Hello::Pair { v, label } => {
            check_version(v)?;
            pairing::accept_pairing(root, &label)
        }
        Hello::Hello { v, public_key } => {
            check_version(v)?;
            pairing::accept_known(root, &public_key)
        }
    };
    let handshake = match handshake {
        Ok(h) => h,
        Err(e) => {
            let _ = reply(stream, &Reply::err("refused"));
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
    stream: &mut UnixStream,
) -> Result<(), String> {
    loop {
        let Some(frame) = read_frame(stream).map_err(|e| format!("read: {e}"))? else {
            return Ok(());
        };
        let parsed: HandshakeFrame =
            serde_json::from_slice(&frame).map_err(|e| format!("bad handshake frame: {e}"))?;

        let step = match pairing::read_message(root, handshake, &parsed.message) {
            Ok(step) => step,
            Err(e) => {
                let _ = reply(stream, &Reply::err("refused"));
                return Err(e);
            }
        };
        let done = step.done;
        reply(stream, &Reply::step(step.message, done)).map_err(|e| format!("write: {e}"))?;
        if done {
            // Authenticated from here, so the same connection carries application traffic,
            // sealed under the session the handshake just established.
            return serve_session(handshake.session_id, stream);
        }
    }
}

/// Bind the socket and serve connections until the process exits.
///
/// Removes a stale socket first: a crash leaves the file behind and bind would otherwise fail
/// forever. That is safe here because the containing directory is the app's own data dir, so
/// nothing else has standing to have put a socket there.
pub fn listen(root: &Path) -> std::io::Result<()> {
    let path = socket_path(root);
    if path.exists() {
        fs::remove_file(&path)?;
    }
    let listener = UnixListener::bind(&path)?;
    restrict(&path)?;

    let root = root.to_path_buf();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let root = root.clone();
            // One thread per connection. There is at most a browser or two, and a handshake
            // is a handful of round trips, so a runtime would be more machinery than this
            // needs.
            thread::spawn(move || {
                if let Err(e) = serve(&root, &mut stream) {
                    // Logged, never sent: see `serve`. At warn rather than debug because
                    // this is the only place the reason exists, and a refusal the user did
                    // not expect is exactly what they will be trying to diagnose.
                    log::warn!("socket connection refused: {e}");
                }
            });
        }
    });
    Ok(())
}

fn restrict(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream as ClientStream;
    use tempfile::TempDir;
    use vault_crypto::handshake;

    /// Drives the extension's half over a real socket. The shipped one runs this same
    /// handshake in WASM through the proxy, so the protocol exercised here is the real one.
    struct Client {
        stream: ClientStream,
    }

    impl Client {
        fn connect(root: &Path) -> Self {
            Self {
                stream: ClientStream::connect(socket_path(root)).expect("connect"),
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

    /// Complete a pairing over the socket, returning the client's keypair.
    fn pair_over_socket(dir: &TempDir, code: &str) -> Result<(String, String), String> {
        let kp = handshake::handshake_generate_keypair().unwrap();
        let start =
            handshake::handshake_enroll_initiator(kp.private_key.clone(), pairing::psk_for(code))
                .map_err(|e| format!("{e:?}"))?;

        let mut client = Client::connect(dir.path());
        client.send(serde_json::json!({
            "kind": "pair", "v": 1, "label": "chrome-extension://abc"
        }));
        client.send(serde_json::json!({ "message": start.message }));

        let reply = client.recv();
        if reply["ok"] != true {
            return Err(format!("refused: {reply}"));
        }
        let msg2 = reply["message"].as_str().ok_or("no msg2")?.to_string();
        let msg3 = handshake::handshake_read(start.session_id, msg2)
            .map_err(|e| format!("{e:?}"))?
            .message
            .ok_or("no msg3")?;

        client.send(serde_json::json!({ "message": msg3 }));
        let done = client.recv();
        if done["done"] != true {
            return Err(format!("not done: {done}"));
        }
        handshake::handshake_close(start.session_id);
        Ok((kp.private_key, kp.public_key))
    }

    #[test]
    fn a_pairing_completes_over_the_socket() {
        let _g = pairing::test_lock();
        let dir = started();
        let code = pairing::begin_pairing().unwrap();

        let (_, client_pub) = pair_over_socket(&dir, &code).unwrap();

        let peers = pairing::paired_peers(dir.path()).unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].public_key, client_pub);
    }

    #[test]
    fn a_paired_client_reconnects_over_the_socket_without_a_code() {
        // The everyday path, and the one that runs every time a browser starts. Pairing is
        // the rare event; this is the one that has to keep working.
        let _g = pairing::test_lock();
        let dir = started();
        let code = pairing::begin_pairing().unwrap();
        let (client_priv, client_pub) = pair_over_socket(&dir, &code).unwrap();

        // No pairing window open, no code anywhere: KK authenticates from the allowlist alone.
        assert!(!pairing::pairing_open());
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
        let code = pairing::begin_pairing().unwrap();
        let (client_priv, client_pub) = pair_over_socket(dir, &code).unwrap();

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
            let code = pairing::begin_pairing().unwrap();
            let (client_priv, client_pub) = pair_over_socket(dir, &code).unwrap();
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
            let sealed =
                handshake::handshake_encrypt(self.session_id, body.to_string()).unwrap();
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
                let listed = link_sync_peers().iter().any(|p| p.peer_id == self.public_key);
                if listed == want {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            panic!("peer registered={} never happened", want);
        }
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
        link_clear_sync_invite();
        let mut link = Linked::open(&dir);

        link.send(serde_json::json!({ "op": "syncInvite" }));
        assert_eq!(link.recv()["ok"], false, "answered with no invite armed");

        link_arm_sync_invite("the-invite".into(), 60_000).unwrap();
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
        link_clear_sync_invite();
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

        link_sync_send(link.public_key.clone(), "hello-from-app".into()).expect("push");

        assert_eq!(link.recv()["sync"], "hello-from-app");
        handshake::handshake_close(link.session_id);
    }

    #[test]
    fn a_sync_frame_from_the_browser_is_relayed_rather_than_answered() {
        // It goes to the webview, so there is nothing to reply with. Answering anyway would put a
        // frame on the wire that the browser would mis-read as the response to its next request.
        let _g = pairing::test_lock();
        let dir = started();
        vault_crypto::unlock_with_vek(vault_crypto::generate_vek().unwrap()).unwrap();
        index_store::set(vec![]);
        let mut link = Linked::open(&dir);
        link.await_registered(true);

        link.send(serde_json::json!({ "op": "sync", "frame": "from-browser" }));
        // The next request's answer is the proof: if the sync frame had produced one, this would
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
        assert!(link_sync_send("not-a-peer".into(), "frame".into()).is_err());
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
        let code = pairing::begin_pairing().unwrap();
        let (_, client_pub) = pair_over_socket(&dir, &code).unwrap();

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
    fn a_wrong_code_is_refused_over_the_socket() {
        let _g = pairing::test_lock();
        let dir = started();
        pairing::begin_pairing().unwrap();

        assert!(pair_over_socket(&dir, "WRONGCOD").is_err());
        assert!(pairing::paired_peers(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn connecting_with_no_pairing_open_is_refused() {
        let _g = pairing::test_lock();
        let dir = started();
        pairing::cancel_pairing();

        let mut client = Client::connect(dir.path());
        client.send(serde_json::json!({
            "kind": "pair", "v": 1, "label": "chrome-extension://evil"
        }));
        let reply = client.recv();
        assert_eq!(reply["ok"], false);
        // Deliberately uninformative: a caller that cannot get in learns nothing about why.
        assert_eq!(reply["error"], "refused");
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
        pairing::begin_pairing().unwrap();

        let mut client = Client::connect(dir.path());
        client.send(serde_json::json!({ "kind": "pair", "v": 99, "label": "future" }));
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

    #[test]
    fn the_socket_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let _g = pairing::test_lock();
        let dir = started();
        let mode = fs::metadata(socket_path(dir.path()))
            .unwrap()
            .permissions()
            .mode();
        // Keeps other accounts out. Says nothing about processes running as this user, which
        // is what the handshake is for.
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_stale_socket_file_does_not_block_startup() {
        let _g = pairing::test_lock();
        let dir = tempfile::tempdir().unwrap();
        // What a crash leaves behind.
        fs::write(socket_path(dir.path()), b"stale").unwrap();
        listen(dir.path()).expect("should replace the stale socket");
    }
}
