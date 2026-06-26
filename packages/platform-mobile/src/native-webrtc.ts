// iOS-only RTCPeerConnection/RTCDataChannel shim backed by the native NativeWebRTC
// Capacitor plugin (the pure-Rust webrtc-rs core via uniffi). iOS WKWebView on the
// capacitor:// scheme exposes no RTCPeerConnection, so the shared @core sync transport
// (built on the browser WebRTC API) dies on device. This re-creates exactly the surface
// webrtc-peer.ts uses, keyed by the u32 peer handle the plugin mints, so the transport
// runs unchanged and still interops with the extension's browser WebRTC. Android's
// WebView has WebRTC, so install() is a no-op there (and on the dev browser). See
// docs/p2p-sync.md.

import { Capacitor, registerPlugin } from "@capacitor/core";

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
	addListener(eventName: string, cb: (data: any) => void): Promise<{ remove: () => Promise<void> }>;
}

const Native = registerPlugin<NativeWebRtcPlugin>("NativeWebRTC");

// peerId -> live connection, so the single set of plugin listeners fans events out to
// the right instance. Populated once createPeer resolves (before any native event can
// fire: ICE/state events only follow setLocalDescription, which is queued behind that).
const peers = new Map<number, NativeRTCPeerConnection>();

type Handler = (() => void) | null;

// One data channel ("sync"). The transport assigns onopen/onmessage/onclose and reads
// readyState before each send; everything else is driven by plugin events.
class NativeRTCDataChannel {
	readonly label: string;
	readyState: "connecting" | "open" | "closing" | "closed" = "connecting";
	onopen: Handler = null;
	onmessage: ((e: { data: string }) => void) | null = null;
	onclose: Handler = null;

	constructor(
		private readonly pc: NativeRTCPeerConnection,
		label: string,
	) {
		this.label = label;
	}

	send(data: string): void {
		// Fire-and-forget like the browser, but serialized through the peer's op queue so
		// SCTP-ordered sends reach the native channel in call order.
		this.pc.enqueue((peer) => Native.send({ peer, data }));
	}

	close(): void {
		if (this.readyState === "closed") return;
		this.readyState = "closed";
		this.onclose?.();
	}

	// --- internal: driven by plugin events ---
	markOpen(): void {
		this.readyState = "open";
		this.onopen?.();
	}
	deliver(data: string): void {
		this.onmessage?.({ data });
	}
}

interface IceCandidateInit {
	candidate: string;
	sdpMid?: string | null;
	sdpMLineIndex?: number | null;
}

// Mirrors the browser RTCIceCandidate just enough: the transport reads e.candidate and
// calls candidate.toJSON() to put on the wire.
function makeCandidate(json: string): IceCandidateInit & { toJSON: () => IceCandidateInit } {
	const parsed = JSON.parse(json) as IceCandidateInit;
	return { ...parsed, toJSON: () => parsed };
}

class NativeRTCPeerConnection {
	connectionState = "new";
	iceConnectionState = "new";
	onicecandidate:
		| ((e: { candidate: (IceCandidateInit & { toJSON: () => unknown }) | null }) => void)
		| null = null;
	onconnectionstatechange: Handler = null;
	oniceconnectionstatechange: Handler = null;
	ondatachannel: ((e: { channel: NativeRTCDataChannel }) => void) | null = null;

	private peerId = -1;
	private channel: NativeRTCDataChannel | null = null;
	// The native peer mints asynchronously; serialize every native op behind it so calls
	// reach Rust in transport order (createDataChannel before createOffer, etc.) and never
	// before the handle exists.
	private tail: Promise<unknown>;

	constructor(config?: { iceServers?: unknown[] }) {
		const iceServersJson = JSON.stringify(config?.iceServers ?? []);
		this.tail = Native.createPeer({ iceServersJson }).then(({ value }) => {
			this.peerId = value;
			peers.set(value, this);
		});
	}

	// Chain a native op behind the handle + all prior ops; keep the chain alive on error.
	enqueue<T>(fn: (peer: number) => Promise<T>): Promise<T> {
		const run = this.tail.then(() => fn(this.peerId));
		this.tail = run.catch(() => undefined);
		return run;
	}

	createDataChannel(label: string): NativeRTCDataChannel {
		const channel = new NativeRTCDataChannel(this, label);
		this.channel = channel;
		void this.enqueue((peer) => Native.createDataChannel({ peer, label }));
		return channel;
	}

	async createOffer(): Promise<{ type: string; sdp: string }> {
		const { value } = await this.enqueue((peer) => Native.createOffer({ peer }));
		return { type: "offer", sdp: value };
	}

	async createAnswer(): Promise<{ type: string; sdp: string }> {
		const { value } = await this.enqueue((peer) => Native.createAnswer({ peer }));
		return { type: "answer", sdp: value };
	}

	setLocalDescription(_desc?: unknown): Promise<void> {
		// The native side applies the offer/answer it just created; the SDP is implicit.
		return this.enqueue((peer) => Native.setLocalDescription({ peer }));
	}

	setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> {
		return this.enqueue((peer) =>
			Native.setRemoteDescription({ peer, type: desc.type, sdp: desc.sdp }),
		);
	}

	addIceCandidate(candidate: IceCandidateInit): Promise<void> {
		return this.enqueue((peer) =>
			Native.addIceCandidate({ peer, candidateJson: JSON.stringify(candidate) }),
		);
	}

	close(): void {
		void this.enqueue((peer) => Native.close({ peer }));
		if (this.peerId >= 0) peers.delete(this.peerId);
		this.channel?.close();
	}

	// --- internal: driven by plugin events ---
	handleIceCandidate(candidateJson: string): void {
		this.onicecandidate?.({ candidate: makeCandidate(candidateJson) });
	}
	handleIceGatheringComplete(): void {
		this.onicecandidate?.({ candidate: null });
	}
	handleDataChannel(): void {
		// Responder side: the remote opened the channel (mirrors pc.ondatachannel).
		const channel = new NativeRTCDataChannel(this, "sync");
		this.channel = channel;
		this.ondatachannel?.({ channel });
	}
	handleDataChannelOpen(): void {
		this.channel?.markOpen();
	}
	handleMessage(data: string): void {
		this.channel?.deliver(data);
	}
	handleConnectionState(state: string): void {
		this.connectionState = state;
		this.onconnectionstatechange?.();
		if (state === "failed" || state === "closed") this.channel?.close();
	}
	handleIceConnectionState(state: string): void {
		this.iceConnectionState = state;
		this.oniceconnectionstatechange?.();
	}
}

let installed = false;

/** Install the native-backed RTCPeerConnection on iOS so the @core sync transport runs.
 * No-op on Android/extension/dev-browser (real RTCPeerConnection) and idempotent. */
export function installNativeWebRtc(): void {
	if (installed || Capacitor.getPlatform() !== "ios") return;
	installed = true;

	const route = (handler: (pc: NativeRTCPeerConnection, e: any) => void) => (e: any) => {
		const pc = peers.get(e.peer);
		if (pc) handler(pc, e);
	};
	void Native.addListener(
		"iceCandidate",
		route((pc, e) => pc.handleIceCandidate(e.candidateJson)),
	);
	void Native.addListener(
		"iceGatheringComplete",
		route((pc) => pc.handleIceGatheringComplete()),
	);
	void Native.addListener(
		"dataChannel",
		route((pc) => pc.handleDataChannel()),
	);
	void Native.addListener(
		"dataChannelOpen",
		route((pc) => pc.handleDataChannelOpen()),
	);
	void Native.addListener(
		"message",
		route((pc, e) => pc.handleMessage(e.data)),
	);
	void Native.addListener(
		"connectionState",
		route((pc, e) => pc.handleConnectionState(e.state)),
	);
	void Native.addListener(
		"iceConnectionState",
		route((pc, e) => pc.handleIceConnectionState(e.state)),
	);

	(globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = NativeRTCPeerConnection;
}
