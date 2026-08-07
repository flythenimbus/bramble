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
    fs,
    io::{Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    path::{Path, PathBuf},
    thread,
};

use serde::{Deserialize, Serialize};

use crate::pairing;

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
            // The session is authenticated from here. Carrying application traffic over it is
            // the next slice; for now the caller has proved who it is and that is the whole
            // job of this connection.
            return Ok(());
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
                    // Logged, never sent: see `serve`.
                    log::debug!("socket connection refused: {e}");
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

    /// Complete a pairing over the socket, returning the client's public key.
    fn pair_over_socket(dir: &TempDir, code: &str) -> Result<String, String> {
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
        Ok(kp.public_key)
    }

    #[test]
    fn a_pairing_completes_over_the_socket() {
        let _g = pairing::test_lock();
        let dir = started();
        let code = pairing::begin_pairing().unwrap();

        let client_pub = pair_over_socket(&dir, &code).unwrap();

        let peers = pairing::paired_peers(dir.path()).unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].public_key, client_pub);
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
