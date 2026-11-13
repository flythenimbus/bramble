// WebKitGTK on Linux is built without WebRTC by every major distribution, so the vault window
// has no RTCPeerConnection and sync could reach other devices only through the relay, never move
// a file. There, the transport runs on the native engine iOS uses (webrtc-rs, in this process)
// behind @core's shim. macOS and Windows webviews have their own WebRTC and are left alone.
// See src-tauri/src/native_webrtc.rs and docs/desktop-port.md.

import {
	installNativeRtc,
	type NativeRtcBridge,
	type NativeRtcEvent,
} from "@core/sync/transport/native-rtc";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** The window event the native side emits, one per NativeRtcEvent. */
const EVENT = "native-webrtc";

const calls: Omit<NativeRtcBridge, "onEvent"> = {
	createPeer: (iceServersJson) => invoke<number>("webrtc_create_peer", { iceServersJson }),
	createDataChannel: (peer, label) => invoke("webrtc_create_data_channel", { peer, label }),
	createOffer: (peer) => invoke<string>("webrtc_create_offer", { peer }),
	createAnswer: (peer) => invoke<string>("webrtc_create_answer", { peer }),
	setLocalDescription: (peer) => invoke("webrtc_set_local_description", { peer }),
	setRemoteDescription: (peer, sdpType, sdp) =>
		invoke("webrtc_set_remote_description", { peer, sdpType, sdp }),
	addIceCandidate: (peer, candidateJson) =>
		invoke("webrtc_add_ice_candidate", { peer, candidateJson }),
	send: (peer, data) => invoke("webrtc_send", { peer, data }),
	close: (peer) => invoke("webrtc_close", { peer }),
};

/**
 * Install the native-backed RTCPeerConnection where the webview has none. Call once, before
 * anything starts sync: the transport checks for WebRTC once and keeps the answer.
 */
export async function installNativeWebRtc(): Promise<void> {
	if (typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection !== "undefined")
		return;
	// Subscribed before any peer exists, so no event can arrive with nobody listening.
	let deliver: (e: NativeRtcEvent) => void = () => {};
	await listen<NativeRtcEvent>(EVENT, (e) => deliver(e.payload));
	// The engine outlives the window. On Wayland a closed window is destroyed and rebuilt, and
	// the peers the old one opened belong to nobody now.
	await invoke("webrtc_close_all").catch(() => {});
	installNativeRtc({
		...calls,
		onEvent: (cb) => {
			deliver = cb;
		},
	});
}
