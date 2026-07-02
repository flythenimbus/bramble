// Relay signaling + peer discovery + WebRTC, role-agnostic. Discovers group peers
// in the room derived from the group key (signed, group-key-encrypted hello/SDP/ICE
// events), opens a data channel to each, and hands the open channel to onPeer. The
// lower pubkey initiates the offer so there's no glare. See docs/p2p-sync.md.

import {
	buildSignalEvent,
	connectSignaling,
	decryptSignal,
	deriveRoomId,
	encryptSignal,
	type NostrEvent,
	type SignalingClient,
	type SocketLike,
	verifyEvent,
} from "..";
import { type Channel, makeChannel } from "./channel";
import type { SignerPair } from "./nostr-signer";
import {
	chunkMessage,
	type DataFrame,
	makeReassembler,
	padMessage,
	unpadMessage,
} from "./relay-channel";
import { createPeer, type Peer, type PeerSignal } from "./webrtc-peer";

export interface PeerSession {
	remotePubkey: string;
	/** True if we created the offer (vs. answered one). */
	initiator: boolean;
	channel: Channel;
	close(): void;
}

export interface MeshOptions {
	relayUrl: string;
	groupKey: Uint8Array;
	/** Room-id label, so enrollment and ongoing sync occupy separate rooms. */
	roomLabel: string;
	signer: SignerPair;
	iceServers?: RTCIceServer[];
	onStatus: (status: string) => void;
	onPeer: (session: PeerSession) => void;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);
const short = (pubkey: string): string => pubkey.slice(0, 8);
const relayHost = (url: string): string => {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
};

// WebRTC availability in THIS runtime context: absent in the Firefox extension background
// (and disabled browser-wide in hardened Firefoxes), present in the Chrome offscreen
// document and mobile webviews. Cached. A data-channel peer is only attempted when both
// sides advertise it (hello caps); otherwise we relay-forward. See docs/firefox-port.md.
let webrtcCache: boolean | null = null;
function webrtcAvailable(): boolean {
	if (webrtcCache !== null) return webrtcCache;
	try {
		if (typeof RTCPeerConnection === "undefined") {
			webrtcCache = false;
		} else {
			const probe = new RTCPeerConnection();
			probe.close();
			webrtcCache = true;
		}
	} catch {
		webrtcCache = false;
	}
	return webrtcCache;
}
// A connect that never reaches the relay (firewall/VPN/no network access, or a
// loopback URL that only resolves on the inviter's machine) should say so instead
// of stalling silently; the relay handshake is a sub-second affair on any reachable
// network, so anything past this is a reachability failure, not slowness.
const CONNECT_TIMEOUT_MS = 10_000;

class Mesh {
	private readonly peers = new Map<string, Peer>();
	private readonly relayPeers = new Map<
		string,
		{ receive: (f: DataFrame) => void; close: () => void }
	>();
	private readonly known = new Set<string>();
	private socket!: WebSocket;
	private client!: SignalingClient;

	constructor(
		private readonly opts: MeshOptions,
		private readonly room: string,
	) {}

	start(): void {
		const url = this.opts.relayUrl;
		const host = relayHost(url);
		this.socket = new WebSocket(url);
		let opened = false;
		// Report the outcome once: the close code distinguishes "couldn't reach the
		// relay" (1006/immediate close — network access, VPN, firewall, or a relay URL
		// only reachable from the inviter) from a relay-side reject, which is the one
		// fact this log was silently dropping. A clean teardown after we connected is
		// expected, not a failure.
		let settled = false;
		const settle = (msg: string) => {
			if (settled) return;
			settled = true;
			this.opts.onStatus(msg);
		};
		const timer = setTimeout(() => {
			if (opened) return;
			settle(`relay unreachable — no response from ${host} (check this device's network access)`);
			try {
				this.socket.close();
			} catch {}
		}, CONNECT_TIMEOUT_MS);
		this.socket.onerror = () => {
			if (!opened) this.opts.onStatus(`relay connection error (${host})`);
		};
		this.socket.onclose = (ev) => {
			clearTimeout(timer);
			const code = (ev as CloseEvent | undefined)?.code;
			settle(
				opened
					? "relay disconnected"
					: `relay unreachable${code ? ` (code ${code})` : ""} — couldn't reach ${host}`,
			);
		};
		this.client = connectSignaling(
			this.socket as unknown as SocketLike,
			this.room,
			(ev) => this.onEvent(ev),
			() => {
				opened = true;
				clearTimeout(timer);
				this.opts.onStatus(`relay connected (${host})`);
			},
		);
		this.sendHello();
	}

	stop(): void {
		for (const peer of this.peers.values()) peer.close();
		for (const relay of this.relayPeers.values()) relay.close();
		this.client?.close();
	}

	private async publish(obj: unknown): Promise<void> {
		try {
			const content = await encryptSignal(this.opts.groupKey, JSON.stringify(obj));
			const event = await buildSignalEvent(this.opts.signer.signer, this.room, content, nowSec());
			this.client.publish(event);
		} catch (e) {
			// Callers fire-and-forget this; surface failures (e.g. a native sign error)
			// instead of silently never announcing, which strands the peer at discovery.
			this.opts.onStatus(`publish failed: ${(e as Error).message}`);
		}
	}

	private sendHello(): void {
		void this.publish({ kind: "hello", rtc: webrtcAvailable() });
	}

	private onEvent(ev: NostrEvent): void {
		void this.handleEvent(ev);
	}

	private async handleEvent(ev: NostrEvent): Promise<void> {
		if (ev.pubkey === this.opts.signer.pubkeyHex) return; // our own echo
		if (!(await verifyEvent(this.opts.signer.verifier, ev))) {
			// A peer whose events fail verification never gets discovered; say so rather
			// than dropping it silently (e.g. a cross-impl sign/verify mismatch).
			this.opts.onStatus(`ignored bad-signature event from ${short(ev.pubkey)}`);
			return;
		}
		let payload: {
			kind?: string;
			to?: string;
			rtc?: boolean;
			sdp?: string;
			candidate?: RTCIceCandidateInit;
			msgId?: number;
			idx?: number;
			total?: number;
			chunk?: string;
		};
		try {
			payload = JSON.parse(await decryptSignal(this.opts.groupKey, ev.content));
		} catch {
			return; // not encrypted under our group key
		}
		if (payload.kind === "hello") return this.discover(ev.pubkey, payload.rtc === true);
		if (payload.to && payload.to !== this.opts.signer.pubkeyHex) return;
		if (payload.kind === "data") return this.routeData(ev.pubkey, payload as DataFrame);
		await this.routeSignal(ev.pubkey, payload as PeerSignal);
	}

	// Deterministic role: lower pubkey offers. Re-announce once per new peer so a
	// late joiner still learns us over the store-nothing relay.
	private discover(remote: string, remoteRtc: boolean): void {
		if (this.known.has(remote)) return;
		this.known.add(remote);
		this.sendHello();
		const initiator = this.opts.signer.pubkeyHex < remote;
		// WebRTC only when both sides have it; otherwise relay-forward (Firefox, WebRTC
		// disabled, or a data channel that won't connect). See docs/firefox-port.md.
		if (webrtcAvailable() && remoteRtc) {
			if (initiator) {
				this.opts.onStatus(`peer ${short(remote)} found — initiating (webrtc)`);
				try {
					this.makePeer(remote, true);
				} catch (e) {
					// RTCPeerConnection / createDataChannel throwing here is otherwise swallowed
					// by the void-ed event handler and looks identical to a stuck "initiating".
					this.opts.onStatus(`peer setup failed: ${(e as Error).message}`);
				}
			} else {
				this.opts.onStatus(`peer ${short(remote)} found — awaiting offer (webrtc)`);
			}
		} else {
			// No offer/answer: both sides open a relay channel now; role picks the Noise seat.
			this.opts.onStatus(`peer ${short(remote)} found — relay transport`);
			this.ensureRelayPeer(remote, initiator);
		}
	}

	private async routeSignal(remote: string, signal: PeerSignal): Promise<void> {
		let peer = this.peers.get(remote);
		if (!peer) {
			if (signal.kind !== "offer") return; // only an offer bootstraps a responder
			this.known.add(remote);
			try {
				peer = this.makePeer(remote, false);
			} catch (e) {
				this.opts.onStatus(`peer setup failed: ${(e as Error).message}`);
				return;
			}
		}
		await peer.handleSignal(signal);
	}

	private makePeer(remote: string, initiator: boolean): Peer {
		let peer: Peer;
		const { channel, push } = makeChannel((data) => peer.send(data));
		peer = createPeer({
			initiator,
			iceServers: this.opts.iceServers,
			onSignal: (signal) => void this.publish({ to: remote, ...signal }),
			onMessage: push,
			onOpen: () =>
				this.opts.onPeer({ remotePubkey: remote, initiator, channel, close: () => peer.close() }),
			onClose: () => {
				this.peers.delete(remote);
				this.opts.onStatus(`channel closed with ${short(remote)}`);
			},
			onState: (state) => this.opts.onStatus(`${short(remote)}: ${state}`),
		});
		this.peers.set(remote, peer);
		return peer;
	}

	// Relay-forward: a peer we can't (or won't) reach over WebRTC. The Channel rides the
	// relay as chunked, group-key-encrypted "data" events; the relay only sees ciphertext.
	// Idempotent + lazy so it works whichever arrives first, a peer's hello or its data.
	private routeData(remote: string, frame: DataFrame): void {
		this.ensureRelayPeer(remote, this.opts.signer.pubkeyHex < remote).receive(frame);
	}

	private ensureRelayPeer(
		remote: string,
		initiator: boolean,
	): { receive: (f: DataFrame) => void; close: () => void } {
		const existing = this.relayPeers.get(remote);
		if (existing) return existing;
		let msgId = 0;
		const { channel, push } = makeChannel((data) => {
			const id = msgId++;
			// Pad to a size bucket before chunking so the relay can't read the true length.
			for (const frame of chunkMessage(id, padMessage(data))) {
				void this.publish({ kind: "data", to: remote, ...frame });
			}
		});
		const entry = {
			receive: makeReassembler((padded) => push(unpadMessage(padded))),
			close: () => {
				this.relayPeers.delete(remote);
			},
		};
		this.relayPeers.set(remote, entry);
		this.opts.onPeer({ remotePubkey: remote, initiator, channel, close: entry.close });
		return entry;
	}
}

export type { Mesh };

/** Join the group's relay room and start discovering + connecting to peers. */
export async function joinMesh(opts: MeshOptions): Promise<Mesh> {
	const mesh = new Mesh(opts, await deriveRoomId(opts.groupKey, opts.roomLabel));
	mesh.start();
	return mesh;
}
