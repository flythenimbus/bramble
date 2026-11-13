// iOS WKWebView on the capacitor:// scheme exposes no RTCPeerConnection, so the sync transport
// runs on the native engine through the NativeWebRTC Capacitor plugin (the pure-Rust webrtc-rs
// core via uniffi), behind the shared shim. Android's WebView has WebRTC, so this is iOS-only.
// See @core/sync/transport/native-rtc and docs/p2p-sync.md.

import { Capacitor, registerPlugin } from "@capacitor/core";
import {
	installNativeRtc,
	type NativeRtcBridge,
	type NativeRtcEvent,
} from "@core/sync/transport/native-rtc";

interface NativeWebRtcPlugin {
	createPeer(o: { iceServersJson: string }): Promise<{ value: number }>;
	createDataChannel(o: { peer: number; label: string }): Promise<void>;
	createOffer(o: { peer: number }): Promise<{ value: string }>;
	createAnswer(o: { peer: number }): Promise<{ value: string }>;
	setLocalDescription(o: { peer: number }): Promise<void>;
	setRemoteDescription(o: { peer: number; type: string; sdp: string }): Promise<void>;
	addIceCandidate(o: { peer: number; candidateJson: string }): Promise<void>;
	send(o: { peer: number; data: string }): Promise<void>;
	close(o: { peer: number }): Promise<void>;
	addListener(
		eventName: string,
		cb: (data: Record<string, unknown>) => void,
	): Promise<{ remove: () => Promise<void> }>;
}

const Native = registerPlugin<NativeWebRtcPlugin>("NativeWebRTC");

/** The plugin fires one listener per event kind, each carrying the peer handle. */
const KINDS: NativeRtcEvent["kind"][] = [
	"iceCandidate",
	"iceGatheringComplete",
	"dataChannel",
	"dataChannelOpen",
	"message",
	"connectionState",
	"iceConnectionState",
];

const bridge: NativeRtcBridge = {
	createPeer: async (iceServersJson) => (await Native.createPeer({ iceServersJson })).value,
	createDataChannel: (peer, label) => Native.createDataChannel({ peer, label }),
	createOffer: async (peer) => (await Native.createOffer({ peer })).value,
	createAnswer: async (peer) => (await Native.createAnswer({ peer })).value,
	setLocalDescription: (peer) => Native.setLocalDescription({ peer }),
	setRemoteDescription: (peer, type, sdp) => Native.setRemoteDescription({ peer, type, sdp }),
	addIceCandidate: (peer, candidateJson) => Native.addIceCandidate({ peer, candidateJson }),
	send: (peer, data) => Native.send({ peer, data }),
	close: (peer) => Native.close({ peer }),
	onEvent: (cb) => {
		for (const kind of KINDS) {
			void Native.addListener(kind, (e) => cb({ ...e, kind } as NativeRtcEvent));
		}
	},
};

let installed = false;

/** Install the native-backed RTCPeerConnection on iOS. A no-op everywhere else (Android, the
 * dev browser), and idempotent. */
export function installNativeWebRtc(): void {
	if (installed || Capacitor.getPlatform() !== "ios") return;
	installed = true;
	installNativeRtc(bridge);
}
