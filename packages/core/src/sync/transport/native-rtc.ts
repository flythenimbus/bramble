// An RTCPeerConnection/RTCDataChannel stand-in backed by the native WebRTC engine (webrtc-rs in
// packages/core-rust/src/webrtc.rs), for webviews that have no RTCPeerConnection: iOS WKWebView
// on capacitor://, and WebKitGTK on Linux. It re-creates exactly the surface webrtc-peer.ts
// uses, keyed by the u32 peer handle the native side mints, so the transport runs unchanged and
// still interops with browser WebRTC. Each host supplies a bridge: a Capacitor plugin on iOS,
// Tauri commands and an event on the desktop. See docs/p2p-sync.md.

/** The native engine's calls, as a host reaches them. */
export interface NativeRtcBridge {
	createPeer(iceServersJson: string): Promise<number>;
	createDataChannel(peer: number, label: string): Promise<void>;
	createOffer(peer: number): Promise<string>;
	createAnswer(peer: number): Promise<string>;
	setLocalDescription(peer: number): Promise<void>;
	setRemoteDescription(peer: number, type: string, sdp: string): Promise<void>;
	addIceCandidate(peer: number, candidateJson: string): Promise<void>;
	send(peer: number, data: string): Promise<void>;
	close(peer: number): Promise<void>;
	/** Deliver every native event, for every peer, to `cb`. Called once. */
	onEvent(cb: (e: NativeRtcEvent) => void): void;
}

/** What the native side reports, named as on the WebRtcObserver trait. */
export type NativeRtcEvent =
	| { kind: "iceCandidate"; peer: number; candidateJson: string }
	| { kind: "iceGatheringComplete"; peer: number }
	| { kind: "dataChannel"; peer: number }
	| { kind: "dataChannelOpen"; peer: number }
	| { kind: "message"; peer: number; data: string }
	| { kind: "connectionState"; peer: number; state: string }
	| { kind: "iceConnectionState"; peer: number; state: string };

type Handler = (() => void) | null;

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

/** The constructor to install as RTCPeerConnection, over `bridge`. */
function nativePeerConnection(bridge: NativeRtcBridge) {
	// peerId -> live connection, so the one event subscription fans out to the right instance.
	// Populated once createPeer resolves, before any native event can fire: ICE and state events
	// only follow setLocalDescription, which is queued behind it.
	const peers = new Map<number, NativeRTCPeerConnection>();

	// One data channel ("sync"). The transport assigns onopen/onmessage/onclose and reads
	// readyState before each send; everything else is driven by native events.
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
			// SCTP-ordered sends reach the native channel in call order. A send that times out leaves
			// the channel unusable, so close it and let the transport reconnect, as a browser would.
			this.pc.enqueue((peer) => bridge.send(peer, data)).catch(() => this.close());
		}

		close(): void {
			if (this.readyState === "closed") return;
			this.readyState = "closed";
			this.onclose?.();
		}

		markOpen(): void {
			this.readyState = "open";
			this.onopen?.();
		}
		deliver(data: string): void {
			this.onmessage?.({ data });
		}
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
			this.tail = bridge.createPeer(JSON.stringify(config?.iceServers ?? [])).then((peer) => {
				this.peerId = peer;
				peers.set(peer, this);
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
			void this.enqueue((peer) => bridge.createDataChannel(peer, label));
			return channel;
		}

		async createOffer(): Promise<{ type: string; sdp: string }> {
			return { type: "offer", sdp: await this.enqueue((peer) => bridge.createOffer(peer)) };
		}

		async createAnswer(): Promise<{ type: string; sdp: string }> {
			return { type: "answer", sdp: await this.enqueue((peer) => bridge.createAnswer(peer)) };
		}

		setLocalDescription(_desc?: unknown): Promise<void> {
			// The native side applies the offer/answer it just created; the SDP is implicit.
			return this.enqueue((peer) => bridge.setLocalDescription(peer));
		}

		setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> {
			return this.enqueue((peer) => bridge.setRemoteDescription(peer, desc.type, desc.sdp));
		}

		addIceCandidate(candidate: IceCandidateInit): Promise<void> {
			return this.enqueue((peer) => bridge.addIceCandidate(peer, JSON.stringify(candidate)));
		}

		close(): void {
			void this.enqueue((peer) => bridge.close(peer));
			if (this.peerId >= 0) peers.delete(this.peerId);
			this.channel?.close();
		}

		handle(e: NativeRtcEvent): void {
			switch (e.kind) {
				case "iceCandidate":
					this.onicecandidate?.({ candidate: makeCandidate(e.candidateJson) });
					break;
				case "iceGatheringComplete":
					this.onicecandidate?.({ candidate: null });
					break;
				case "dataChannel": {
					// Responder side: the remote opened the channel (mirrors pc.ondatachannel).
					const channel = new NativeRTCDataChannel(this, "sync");
					this.channel = channel;
					this.ondatachannel?.({ channel });
					break;
				}
				case "dataChannelOpen":
					this.channel?.markOpen();
					break;
				case "message":
					this.channel?.deliver(e.data);
					break;
				case "connectionState":
					this.connectionState = e.state;
					this.onconnectionstatechange?.();
					if (e.state === "failed" || e.state === "closed") this.channel?.close();
					break;
				case "iceConnectionState":
					this.iceConnectionState = e.state;
					this.oniceconnectionstatechange?.();
					break;
			}
		}
	}

	bridge.onEvent((e) => peers.get(e.peer)?.handle(e));
	return NativeRTCPeerConnection;
}

/** Make `RTCPeerConnection` the native-backed one, so the sync transport runs. The host decides
 * whether its webview needs it; call once. */
export function installNativeRtc(bridge: NativeRtcBridge): void {
	(globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = nativePeerConnection(bridge);
}
