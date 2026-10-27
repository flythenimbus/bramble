//! Stands in for the browser extension, so the desktop half of the pairing can be exercised
//! end to end before any extension code exists.
//!
//!   cargo run --example fake-extension -- <CODE>
//!
//! Spawns the real proxy and talks to it over stdin/stdout exactly as Chrome would, so this
//! covers the whole chain: proxy, socket, handshake, allowlist. The only thing it does not
//! cover is the extension's own code, which is the point.
//!
//! The PSK derivation is reimplemented rather than imported, deliberately: if this and
//! src/pairing.rs ever disagree the handshake fails, which is exactly the check worth having.

use std::{
    io::{Read, Write},
    process::{Child, Command, Stdio},
};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use sha2::{Digest, Sha256};
use vault_crypto::handshake;

/// Must match `PSK_INFO` in src/pairing.rs.
const PSK_INFO: &[u8] = b"bramble/desktop/extension-pairing/psk/v1";

fn psk_for(code: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(PSK_INFO);
    hasher.update(code.trim().to_ascii_uppercase().as_bytes());
    B64.encode(hasher.finalize())
}

fn send(child: &mut Child, value: &serde_json::Value) {
    let body = serde_json::to_vec(value).expect("encode");
    let stdin = child.stdin.as_mut().expect("stdin");
    stdin
        .write_all(&(body.len() as u32).to_le_bytes())
        .expect("write len");
    stdin.write_all(&body).expect("write body");
    stdin.flush().expect("flush");
}

fn recv(child: &mut Child) -> serde_json::Value {
    let stdout = child.stdout.as_mut().expect("stdout");
    let mut len = [0u8; 4];
    stdout.read_exact(&mut len).expect("read len");
    let mut body = vec![0u8; u32::from_le_bytes(len) as usize];
    stdout.read_exact(&mut body).expect("read body");
    serde_json::from_slice(&body).expect("parse")
}

/// Where this stand-in remembers its keypair between runs, so `--reconnect` can prove the
/// everyday path: an already-paired browser reconnecting with no code at all.
fn key_file() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/fake-extension-key.json")
}

/// The app's own static public key, which KK needs up front. Read from the allowlist file
/// because a real extension learns it during pairing and stores it.
fn app_public_key() -> String {
    let home = std::env::var("HOME").expect("HOME");
    let path = format!("{home}/Library/Application Support/app.bramble.desktop/pairing.json");
    let raw = std::fs::read(path).expect("read pairing.json");
    let value: serde_json::Value = serde_json::from_slice(&raw).expect("parse pairing.json");
    value["publicKey"].as_str().expect("publicKey").to_string()
}

fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next().unwrap_or_else(|| {
        eprintln!("usage: cargo run --example fake-extension -- <CODE>");
        eprintln!("       cargo run --example fake-extension -- --reconnect");
        std::process::exit(2);
    });
    if first == "--reconnect" {
        reconnect();
        return;
    }
    let code = first;

    let proxy = std::env::current_exe()
        .expect("current exe")
        .parent()
        .expect("parent")
        // examples land in target/debug/examples, the proxy one level up.
        .parent()
        .expect("target dir")
        .join("bramble-proxy");
    println!("proxy: {}", proxy.display());

    let mut child = Command::new(&proxy)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn proxy");

    let kp = handshake::handshake_generate_keypair().expect("keypair");
    println!("our static key: {}", kp.public_key);

    let start = handshake::handshake_enroll_initiator(kp.private_key.clone(), psk_for(&code))
        .expect("enroll initiator");

    send(
        &mut child,
        &serde_json::json!({
            "kind": "pair",
            "v": 1,
            "label": "chrome-extension://kmokhdhoggbdcgoepifeckhgbfakaknm",
        }),
    );
    send(&mut child, &serde_json::json!({ "message": start.message }));

    let reply = recv(&mut child);
    if reply["ok"] != true {
        eprintln!("refused at msg1: {reply}");
        std::process::exit(1);
    }
    let msg2 = reply["message"].as_str().expect("msg2").to_string();

    let msg3 = handshake::handshake_read(start.session_id, msg2)
        .expect("read msg2")
        .message
        .expect("msg3");
    send(&mut child, &serde_json::json!({ "message": msg3 }));

    let done = recv(&mut child);
    let _ = child.kill();
    if done["done"] == true {
        std::fs::write(
            key_file(),
            serde_json::to_vec(&serde_json::json!({
                "privateKey": kp.private_key,
                "publicKey": kp.public_key,
            }))
            .expect("encode key"),
        )
        .expect("save key");
        println!("PAIRED. This key is now allowlisted: {}", kp.public_key);
        println!("Now run: cargo run --example fake-extension -- --reconnect");
    } else {
        eprintln!("did not complete: {done}");
        std::process::exit(1);
    }
}

/// The everyday path: an allowlisted browser reconnecting over KK, with no code involved.
fn reconnect() {
    let raw = std::fs::read(key_file()).expect("no saved key; pair first");
    let saved: serde_json::Value = serde_json::from_slice(&raw).expect("parse saved key");
    let private = saved["privateKey"]
        .as_str()
        .expect("privateKey")
        .to_string();
    let public = saved["publicKey"].as_str().expect("publicKey").to_string();
    println!("reconnecting as {public}");

    let proxy = std::env::current_exe()
        .expect("current exe")
        .parent()
        .expect("parent")
        .parent()
        .expect("target dir")
        .join("bramble-proxy");
    let mut child = Command::new(&proxy)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn proxy");

    // KK needs the peer's static key up front, which is exactly what makes completing it
    // proof that both ends are who the allowlist says.
    let start =
        handshake::handshake_start_initiator(private, app_public_key()).expect("start initiator");

    send(
        &mut child,
        &serde_json::json!({ "kind": "hello", "v": 1, "publicKey": public }),
    );
    send(&mut child, &serde_json::json!({ "message": start.message }));

    let reply = recv(&mut child);
    let _ = child.kill();
    if reply["ok"] == true && reply["done"] == true {
        println!("RECONNECTED over KK with no code.");
    } else {
        eprintln!("reconnect failed: {reply}");
        std::process::exit(1);
    }
}
