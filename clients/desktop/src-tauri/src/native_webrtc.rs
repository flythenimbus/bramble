//! Native WebRTC for the vault window on Linux.
//!
//! WebKitGTK is built without WebRTC by every major distribution (Debian, Ubuntu, Fedora), and no
//! setting turns it on, so the webview has no `RTCPeerConnection`. Sync's peer connections run
//! instead on the engine the iOS app uses (`vault_crypto::webrtc`, pure-Rust webrtc-rs), behind
//! @core's shim (`src/native-webrtc.ts`). These commands are that shim's calls, and its events
//! come back as one window event. Linux only: macOS and Windows webviews have WebRTC of their
//! own, so their binaries don't carry the engine. See docs/desktop-port.md.

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use vault_crypto::{webrtc, CryptoError};

use crate::lifetime::MAIN;

/// The window event the shim listens on.
const EVENT: &str = "native-webrtc";

type CmdResult<T> = Result<T, String>;

/// One engine event, shaped as @core's `NativeRtcEvent`.
#[derive(Serialize, Debug, Clone)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Event {
    IceCandidate { peer: u32, candidate_json: String },
    IceGatheringComplete { peer: u32 },
    DataChannel { peer: u32 },
    DataChannelOpen { peer: u32 },
    Message { peer: u32, data: String },
    ConnectionState { peer: u32, state: String },
    IceConnectionState { peer: u32, state: String },
}

/// Hands the engine's events to the vault window, the only one that syncs.
struct ToWindow(AppHandle);

impl ToWindow {
    fn send(&self, e: Event) {
        let _ = self.0.emit_to(MAIN, EVENT, e);
    }
}

impl webrtc::WebRtcObserver for ToWindow {
    fn on_ice_candidate(&self, peer: u32, candidate_json: String) {
        self.send(Event::IceCandidate {
            peer,
            candidate_json,
        });
    }
    fn on_ice_gathering_complete(&self, peer: u32) {
        self.send(Event::IceGatheringComplete { peer });
    }
    fn on_data_channel_open(&self, peer: u32) {
        self.send(Event::DataChannelOpen { peer });
    }
    fn on_data_channel(&self, peer: u32) {
        self.send(Event::DataChannel { peer });
    }
    fn on_message(&self, peer: u32, data: String) {
        self.send(Event::Message { peer, data });
    }
    fn on_connection_state(&self, peer: u32, state: String) {
        self.send(Event::ConnectionState { peer, state });
    }
    fn on_ice_connection_state(&self, peer: u32, state: String) {
        self.send(Event::IceConnectionState { peer, state });
    }
}

/// Run an engine call off the main thread: each can block for up to its 15 s deadline, which a
/// synchronous command would spend holding the whole UI.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, CryptoError> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn webrtc_create_peer(app: AppHandle, ice_servers_json: String) -> CmdResult<u32> {
    blocking(move || webrtc::webrtc_create_peer(ice_servers_json, Box::new(ToWindow(app)))).await
}

#[tauri::command]
pub async fn webrtc_create_data_channel(peer: u32, label: String) -> CmdResult<()> {
    blocking(move || webrtc::webrtc_create_data_channel(peer, label)).await
}

#[tauri::command]
pub async fn webrtc_create_offer(peer: u32) -> CmdResult<String> {
    blocking(move || webrtc::webrtc_create_offer(peer)).await
}

#[tauri::command]
pub async fn webrtc_create_answer(peer: u32) -> CmdResult<String> {
    blocking(move || webrtc::webrtc_create_answer(peer)).await
}

#[tauri::command]
pub async fn webrtc_set_local_description(peer: u32) -> CmdResult<()> {
    blocking(move || webrtc::webrtc_set_local_description(peer)).await
}

#[tauri::command]
pub async fn webrtc_set_remote_description(
    peer: u32,
    sdp_type: String,
    sdp: String,
) -> CmdResult<()> {
    blocking(move || webrtc::webrtc_set_remote_description(peer, sdp_type, sdp)).await
}

#[tauri::command]
pub async fn webrtc_add_ice_candidate(peer: u32, candidate_json: String) -> CmdResult<()> {
    blocking(move || webrtc::webrtc_add_ice_candidate(peer, candidate_json)).await
}

#[tauri::command]
pub async fn webrtc_send(peer: u32, data: String) -> CmdResult<()> {
    blocking(move || webrtc::webrtc_send(peer, data)).await
}

#[tauri::command]
pub fn webrtc_close(peer: u32) {
    webrtc::webrtc_close(peer);
}

#[tauri::command]
pub fn webrtc_close_all() {
    webrtc::webrtc_close_all();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, to_value};
    use std::sync::{mpsc, Mutex};
    use std::time::{Duration, Instant};

    /// Hands each peer's candidates and channel opens to the test, by handle.
    struct Recorder(Mutex<mpsc::Sender<(u32, Option<String>)>>);

    impl webrtc::WebRtcObserver for Recorder {
        fn on_ice_candidate(&self, peer: u32, candidate_json: String) {
            let _ = self.0.lock().unwrap().send((peer, Some(candidate_json)));
        }
        fn on_ice_gathering_complete(&self, _peer: u32) {}
        fn on_data_channel_open(&self, peer: u32) {
            let _ = self.0.lock().unwrap().send((peer, None));
        }
        fn on_data_channel(&self, _peer: u32) {}
        fn on_message(&self, _peer: u32, _data: String) {}
        fn on_connection_state(&self, _peer: u32, _state: String) {}
        fn on_ice_connection_state(&self, _peer: u32, _state: String) {}
    }

    #[test]
    fn the_engine_opens_a_channel_in_this_apps_build() {
        // This build links rustls with two crypto backends, aws-lc-rs through reqwest and ring
        // through webrtc-rs's DTLS, and rustls then can't pick a process default by itself. The
        // DTLS task panicked right after ICE connected, so no channel ever opened.
        let (tx, rx) = mpsc::channel();
        let rec = || Box::new(Recorder(Mutex::new(tx.clone())));
        let a = webrtc::webrtc_create_peer("[]".into(), rec()).unwrap();
        let b = webrtc::webrtc_create_peer("[]".into(), rec()).unwrap();
        webrtc::webrtc_create_data_channel(a, "sync".into()).unwrap();
        let offer = webrtc::webrtc_create_offer(a).unwrap();
        webrtc::webrtc_set_local_description(a).unwrap();
        webrtc::webrtc_set_remote_description(b, "offer".into(), offer).unwrap();
        let answer = webrtc::webrtc_create_answer(b).unwrap();
        webrtc::webrtc_set_local_description(b).unwrap();
        webrtc::webrtc_set_remote_description(a, "answer".into(), answer).unwrap();

        let deadline = Instant::now() + Duration::from_secs(20);
        let mut open = std::collections::HashSet::new();
        while open.len() < 2 {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left).expect("no channel opened") {
                (peer, Some(cand)) => {
                    let other = if peer == a { b } else { a };
                    webrtc::webrtc_add_ice_candidate(other, cand).unwrap();
                }
                (peer, None) => {
                    open.insert(peer);
                }
            }
        }
        webrtc::webrtc_close(a);
        webrtc::webrtc_close(b);
    }

    #[test]
    fn events_are_shaped_as_the_shim_reads_them() {
        let cases = [
            (
                Event::IceCandidate {
                    peer: 3,
                    candidate_json: "{}".into(),
                },
                json!({"kind": "iceCandidate", "peer": 3, "candidateJson": "{}"}),
            ),
            (
                Event::IceGatheringComplete { peer: 3 },
                json!({"kind": "iceGatheringComplete", "peer": 3}),
            ),
            (
                Event::DataChannel { peer: 3 },
                json!({"kind": "dataChannel", "peer": 3}),
            ),
            (
                Event::DataChannelOpen { peer: 3 },
                json!({"kind": "dataChannelOpen", "peer": 3}),
            ),
            (
                Event::Message {
                    peer: 3,
                    data: "hi".into(),
                },
                json!({"kind": "message", "peer": 3, "data": "hi"}),
            ),
            (
                Event::ConnectionState {
                    peer: 3,
                    state: "connected".into(),
                },
                json!({"kind": "connectionState", "peer": 3, "state": "connected"}),
            ),
            (
                Event::IceConnectionState {
                    peer: 3,
                    state: "checking".into(),
                },
                json!({"kind": "iceConnectionState", "peer": 3, "state": "checking"}),
            ),
        ];
        for (event, want) in cases {
            assert_eq!(to_value(&event).unwrap(), want);
        }
    }
}
