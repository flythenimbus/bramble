//! Native WebRTC data channel for iOS, behind the `webrtc` feature.
//!
//! iOS WKWebView on the `capacitor://` scheme exposes no `RTCPeerConnection`, so the
//! shared @core sync transport (built on the browser WebRTC API) dies on device. This
//! backs that API with the pure-Rust `webrtc` crate (ICE/DTLS/SCTP), exposed through the
//! existing uniffi pipeline; a JS shim installed only on iOS re-creates the browser
//! `RTCPeerConnection`/`RTCDataChannel` surface so the transport runs unchanged and still
//! interops with the extension's browser WebRTC. Android's WebView already has WebRTC, so
//! this is iOS-only and excluded from the Android build. See docs/p2p-sync.md.
//!
//! Peers live in a registry keyed by a u32 handle (mirrors handshake.rs); the JS shim
//! holds the handle. webrtc-rs is async, so a global multi-thread tokio runtime drives it:
//! request/response calls `block_on`, fire-and-forget calls `spawn`. Connection events
//! (ICE candidates, channel open/message, state) flow back through a uniffi callback
//! interface the Swift plugin implements.
//!
//! The module is named `webrtc` while the crate dependency is also `webrtc`; inside here
//! the crate is reached via the leading-colon path `::webrtc::` to disambiguate.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Deserialize;
use tokio::runtime::{Builder, Runtime};

use ::webrtc::api::setting_engine::SettingEngine;
use ::webrtc::api::APIBuilder;
use ::webrtc::data_channel::data_channel_message::DataChannelMessage;
use ::webrtc::data_channel::RTCDataChannel;
use ::webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use ::webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use ::webrtc::ice_transport::ice_server::RTCIceServer;
use ::webrtc::peer_connection::configuration::RTCConfiguration;
use ::webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use ::webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use ::webrtc::peer_connection::RTCPeerConnection;

use crate::CryptoError;

// ---- events to the foreign side (callback interface) ----

/// Connection events delivered to the foreign side; the Swift NativeWebRTC plugin
/// implements this and forwards each to JS via `notifyListeners`. Every call carries the
/// peer handle so one observer fans out to many peers. Fire-and-forget: the impl must
/// return promptly (it only posts to the webview), since these fire on runtime threads.
#[uniffi::export(callback_interface)]
pub trait WebRtcObserver: Send + Sync {
    /// A gathered local ICE candidate, JSON `{candidate, sdpMid, sdpMLineIndex}`.
    fn on_ice_candidate(&self, peer: u32, candidate_json: String);
    /// ICE gathering finished (browser's null-candidate signal).
    fn on_ice_gathering_complete(&self, peer: u32);
    /// The data channel reached `open` (both initiator and responder sides).
    fn on_data_channel_open(&self, peer: u32);
    /// The remote opened the channel (responder side; mirrors `pc.ondatachannel`).
    fn on_data_channel(&self, peer: u32);
    /// An inbound text message on the data channel.
    fn on_message(&self, peer: u32, data: String);
    /// `pc.connectionState` transition (e.g. "connected", "failed", "closed").
    fn on_connection_state(&self, peer: u32, state: String);
    /// `pc.iceConnectionState` transition (surfaces an ICE stall sooner).
    fn on_ice_connection_state(&self, peer: u32, state: String);
}

// ---- runtime + registry ----

fn runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime")
    })
}

struct PeerHandle {
    pc: Arc<RTCPeerConnection>,
    observer: Arc<dyn WebRtcObserver>,
    // The data channel: created here on the initiator, captured in on_data_channel on the
    // responder. Holds None until then.
    channel: Mutex<Option<Arc<RTCDataChannel>>>,
    // The locally created offer/answer, awaiting set_local_description (which applies the
    // exact description we made rather than re-parsing the SDP string).
    pending_local: Mutex<Option<RTCSessionDescription>>,
}

struct Registry {
    next: u32,
    peers: HashMap<u32, Arc<PeerHandle>>,
}

fn registry() -> &'static Mutex<Registry> {
    static REG: OnceLock<Mutex<Registry>> = OnceLock::new();
    REG.get_or_init(|| {
        Mutex::new(Registry {
            next: 1,
            peers: HashMap::new(),
        })
    })
}

fn ce(msg: String) -> CryptoError {
    CryptoError::Crypto { msg }
}

fn get_peer(id: u32) -> Result<Arc<PeerHandle>, CryptoError> {
    registry()
        .lock()
        .unwrap()
        .peers
        .get(&id)
        .cloned()
        .ok_or_else(|| ce("unknown peer".into()))
}

// ---- ICE server parsing (the app's RTCIceServer[] as JSON) ----

#[derive(Deserialize)]
struct IceServerJson {
    #[serde(default)]
    urls: Option<Urls>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    credential: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Urls {
    One(String),
    Many(Vec<String>),
}

fn parse_ice_servers(json: &str) -> Result<Vec<RTCIceServer>, CryptoError> {
    if json.trim().is_empty() {
        return Ok(vec![]);
    }
    let raw: Vec<IceServerJson> =
        serde_json::from_str(json).map_err(|e| ce(format!("ice servers json: {e}")))?;
    Ok(raw
        .into_iter()
        .map(|s| RTCIceServer {
            urls: match s.urls {
                Some(Urls::One(u)) => vec![u],
                Some(Urls::Many(u)) => u,
                None => vec![],
            },
            username: s.username.unwrap_or_default(),
            credential: s.credential.unwrap_or_default(),
        })
        .filter(|s| !s.urls.is_empty())
        .collect())
}

// ---- data channel wiring (shared by initiator + responder) ----

fn wire_data_channel(peer: u32, observer: &Arc<dyn WebRtcObserver>, dc: &Arc<RTCDataChannel>) {
    let on_open_obs = observer.clone();
    dc.on_open(Box::new(move || {
        Box::pin(async move { on_open_obs.on_data_channel_open(peer) })
    }));
    let on_msg_obs = observer.clone();
    dc.on_message(Box::new(move |msg: DataChannelMessage| {
        let obs = on_msg_obs.clone();
        Box::pin(async move {
            obs.on_message(peer, String::from_utf8_lossy(&msg.data).into_owned())
        })
    }));
}

// ---- core (binding-agnostic) ----

fn create_peer_core(
    ice_servers_json: String,
    observer: Arc<dyn WebRtcObserver>,
) -> Result<u32, CryptoError> {
    let ice_servers = parse_ice_servers(&ice_servers_json)?;
    let pc = runtime().block_on(async move {
        // Disable mDNS: iOS multicast needs a special entitlement, so a .local candidate
        // can't be resolved on device anyway. Raw-IP host candidates interop with the
        // browser and reach it via host/STUN/TURN; this just avoids binding a multicast
        // socket that would error during gathering.
        let mut se = SettingEngine::default();
        se.set_ice_multicast_dns_mode(::webrtc::ice::mdns::MulticastDnsMode::Disabled);
        let api = APIBuilder::new().with_setting_engine(se).build();
        api.new_peer_connection(RTCConfiguration {
            ice_servers,
            ..Default::default()
        })
        .await
    });
    let pc = Arc::new(pc.map_err(|e| ce(format!("new peer connection: {e}")))?);

    // Reserve the handle id up front so the callbacks below can carry it.
    let id = {
        let mut reg = registry().lock().unwrap();
        let id = reg.next;
        reg.next = reg.next.wrapping_add(1).max(1);
        id
    };

    let cand_obs = observer.clone();
    pc.on_ice_candidate(Box::new(move |cand: Option<RTCIceCandidate>| {
        let obs = cand_obs.clone();
        Box::pin(async move {
            match cand {
                Some(c) => {
                    if let Ok(init) = c.to_json() {
                        if let Ok(json) = serde_json::to_string(&init) {
                            obs.on_ice_candidate(id, json);
                        }
                    }
                }
                None => obs.on_ice_gathering_complete(id),
            }
        })
    }));

    let conn_obs = observer.clone();
    pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
        let obs = conn_obs.clone();
        Box::pin(async move { obs.on_connection_state(id, s.to_string()) })
    }));

    let ice_obs = observer.clone();
    pc.on_ice_connection_state_change(Box::new(move |s: RTCIceConnectionState| {
        let obs = ice_obs.clone();
        Box::pin(async move { obs.on_ice_connection_state(id, s.to_string()) })
    }));

    // Responder: the remote creates the channel; capture + wire it, then notify JS.
    let dc_obs = observer.clone();
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let obs = dc_obs.clone();
        Box::pin(async move {
            wire_data_channel(id, &obs, &dc);
            if let Ok(handle) = get_peer(id) {
                *handle.channel.lock().unwrap() = Some(dc);
            }
            obs.on_data_channel(id);
        })
    }));

    registry().lock().unwrap().peers.insert(
        id,
        Arc::new(PeerHandle {
            pc,
            observer,
            channel: Mutex::new(None),
            pending_local: Mutex::new(None),
        }),
    );
    Ok(id)
}

fn create_data_channel_core(peer: u32, label: String) -> Result<(), CryptoError> {
    let handle = get_peer(peer)?;
    let dc = runtime()
        .block_on(async { handle.pc.create_data_channel(&label, None).await })
        .map_err(|e| ce(format!("create data channel: {e}")))?;
    wire_data_channel(peer, &handle.observer, &dc);
    *handle.channel.lock().unwrap() = Some(dc);
    Ok(())
}

fn create_offer_core(peer: u32) -> Result<String, CryptoError> {
    let handle = get_peer(peer)?;
    let offer = runtime()
        .block_on(async { handle.pc.create_offer(None).await })
        .map_err(|e| ce(format!("create offer: {e}")))?;
    let sdp = offer.sdp.clone();
    *handle.pending_local.lock().unwrap() = Some(offer);
    Ok(sdp)
}

fn create_answer_core(peer: u32) -> Result<String, CryptoError> {
    let handle = get_peer(peer)?;
    let answer = runtime()
        .block_on(async { handle.pc.create_answer(None).await })
        .map_err(|e| ce(format!("create answer: {e}")))?;
    let sdp = answer.sdp.clone();
    *handle.pending_local.lock().unwrap() = Some(answer);
    Ok(sdp)
}

fn set_local_description_core(peer: u32) -> Result<(), CryptoError> {
    let handle = get_peer(peer)?;
    let desc = handle
        .pending_local
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| ce("no pending local description".into()))?;
    runtime()
        .block_on(async { handle.pc.set_local_description(desc).await })
        .map_err(|e| ce(format!("set local description: {e}")))
}

fn set_remote_description_core(peer: u32, sdp_type: String, sdp: String) -> Result<(), CryptoError> {
    let handle = get_peer(peer)?;
    let desc = match sdp_type.as_str() {
        "offer" => RTCSessionDescription::offer(sdp),
        "answer" => RTCSessionDescription::answer(sdp),
        "pranswer" => RTCSessionDescription::pranswer(sdp),
        other => return Err(ce(format!("unknown sdp type: {other}"))),
    }
    .map_err(|e| ce(format!("session description: {e}")))?;
    runtime()
        .block_on(async { handle.pc.set_remote_description(desc).await })
        .map_err(|e| ce(format!("set remote description: {e}")))
}

fn add_ice_candidate_core(peer: u32, candidate_json: String) -> Result<(), CryptoError> {
    let handle = get_peer(peer)?;
    let init: RTCIceCandidateInit =
        serde_json::from_str(&candidate_json).map_err(|e| ce(format!("ice candidate json: {e}")))?;
    runtime()
        .block_on(async { handle.pc.add_ice_candidate(init).await })
        .map_err(|e| ce(format!("add ice candidate: {e}")))
}

fn send_core(peer: u32, data: String) -> Result<(), CryptoError> {
    let handle = get_peer(peer)?;
    let dc = handle
        .channel
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| ce("no data channel".into()))?;
    runtime()
        .block_on(async { dc.send_text(data).await })
        .map(|_| ())
        .map_err(|e| ce(format!("send: {e}")))
}

fn close_core(peer: u32) {
    if let Some(handle) = registry().lock().unwrap().peers.remove(&peer) {
        // Fire-and-forget: the transport's close() is synchronous. The spawned task holds
        // the last Arc until close completes, then drops the peer (and its callbacks).
        runtime().spawn(async move {
            let _ = handle.pc.close().await;
        });
    }
}

// ---- uniffi exports (iOS only; no wasm twin, webrtc-rs is native-only) ----

/// Create a peer connection with the given ICE servers (the app's `RTCIceServer[]` as
/// JSON). Returns a u32 handle the shim keys everything else on.
#[uniffi::export]
pub fn webrtc_create_peer(
    ice_servers_json: String,
    observer: Box<dyn WebRtcObserver>,
) -> Result<u32, CryptoError> {
    create_peer_core(ice_servers_json, observer.into())
}

/// Initiator: create the "sync" data channel before making the offer.
#[uniffi::export]
pub fn webrtc_create_data_channel(peer: u32, label: String) -> Result<(), CryptoError> {
    create_data_channel_core(peer, label)
}

/// Create an SDP offer; held pending until set_local_description applies it.
#[uniffi::export]
pub fn webrtc_create_offer(peer: u32) -> Result<String, CryptoError> {
    create_offer_core(peer)
}

/// Create an SDP answer; held pending until set_local_description applies it.
#[uniffi::export]
pub fn webrtc_create_answer(peer: u32) -> Result<String, CryptoError> {
    create_answer_core(peer)
}

/// Apply the pending local offer/answer (the shim passes the SDP it received, but we
/// apply the exact description object we created, so the arg is implicit).
#[uniffi::export]
pub fn webrtc_set_local_description(peer: u32) -> Result<(), CryptoError> {
    set_local_description_core(peer)
}

/// Apply the remote offer/answer.
#[uniffi::export]
pub fn webrtc_set_remote_description(
    peer: u32,
    sdp_type: String,
    sdp: String,
) -> Result<(), CryptoError> {
    set_remote_description_core(peer, sdp_type, sdp)
}

/// Add a remote ICE candidate (JSON `{candidate, sdpMid, sdpMLineIndex}`).
#[uniffi::export]
pub fn webrtc_add_ice_candidate(peer: u32, candidate_json: String) -> Result<(), CryptoError> {
    add_ice_candidate_core(peer, candidate_json)
}

/// Send a text message over the data channel.
#[uniffi::export]
pub fn webrtc_send(peer: u32, data: String) -> Result<(), CryptoError> {
    send_core(peer, data)
}

/// Close the peer connection and drop the handle.
#[uniffi::export]
pub fn webrtc_close(peer: u32) {
    close_core(peer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ice_servers_handles_string_and_array_urls() {
        let json = r#"[
            {"urls":"stun:stun.l.google.com:19302"},
            {"urls":["turn:turn.example:3478"],"username":"u","credential":"p"}
        ]"#;
        let servers = parse_ice_servers(json).unwrap();
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].urls, vec!["stun:stun.l.google.com:19302"]);
        assert_eq!(servers[1].username, "u");
        assert_eq!(servers[1].credential, "p");
    }

    #[test]
    fn parse_ice_servers_empty_is_ok() {
        assert!(parse_ice_servers("").unwrap().is_empty());
        assert!(parse_ice_servers("[]").unwrap().is_empty());
    }

    #[test]
    fn candidate_init_round_trips_browser_shape() {
        // The browser sends {candidate, sdpMid, sdpMLineIndex}; it must deserialize into
        // webrtc-rs's RTCIceCandidateInit (camelCase, sdpMLineIndex rename) and back.
        let json = r#"{"candidate":"candidate:1 1 udp 2 1.2.3.4 5 typ host","sdpMid":"0","sdpMLineIndex":0}"#;
        let init: RTCIceCandidateInit = serde_json::from_str(json).unwrap();
        assert_eq!(init.sdp_mid.as_deref(), Some("0"));
        assert_eq!(init.sdp_mline_index, Some(0));
        let back = serde_json::to_string(&init).unwrap();
        assert!(back.contains("\"sdpMLineIndex\":0"));
        assert!(back.contains("\"sdpMid\":\"0\""));
    }
}
