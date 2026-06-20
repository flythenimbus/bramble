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
	onStatus: (status: string) => void;
	onPeer: (session: PeerSession) => void;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);
const short = (pubkey: string): string => pubkey.slice(0, 8);

class Mesh {
	private readonly peers = new Map<string, Peer>();
	private readonly known = new Set<string>();
	private socket!: WebSocket;
	private client!: SignalingClient;

	constructor(
		private readonly opts: MeshOptions,
		private readonly room: string,
	) {}

	start(): void {
		this.socket = new WebSocket(this.opts.relayUrl);
		this.socket.onerror = () => this.opts.onStatus("relay connection error");
		this.socket.onclose = () => this.opts.onStatus("relay disconnected");
		this.client = connectSignaling(this.socket as unknown as SocketLike, this.room, (ev) =>
			this.onEvent(ev),
		);
		void this.publish({ kind: "hello" });
	}

	stop(): void {
		for (const peer of this.peers.values()) peer.close();
		this.client?.close();
	}

	private async publish(obj: unknown): Promise<void> {
		const content = await encryptSignal(this.opts.groupKey, JSON.stringify(obj));
		const event = await buildSignalEvent(this.opts.signer.signer, this.room, content, nowSec());
		this.client.publish(event);
	}

	private onEvent(ev: NostrEvent): void {
		void this.handleEvent(ev);
	}

	private async handleEvent(ev: NostrEvent): Promise<void> {
		if (ev.pubkey === this.opts.signer.pubkeyHex) return; // our own echo
		if (!(await verifyEvent(this.opts.signer.verifier, ev))) return;
		let payload: { kind?: string; to?: string; sdp?: string; candidate?: RTCIceCandidateInit };
		try {
			payload = JSON.parse(await decryptSignal(this.opts.groupKey, ev.content));
		} catch {
			return; // not encrypted under our group key
		}
		if (payload.kind === "hello") return this.discover(ev.pubkey);
		if (payload.to && payload.to !== this.opts.signer.pubkeyHex) return;
		await this.routeSignal(ev.pubkey, payload as PeerSignal);
	}

	// Deterministic role: lower pubkey offers. Re-announce once per new peer so a
	// late joiner still learns us over the store-nothing relay.
	private discover(remote: string): void {
		if (this.known.has(remote)) return;
		this.known.add(remote);
		void this.publish({ kind: "hello" });
		if (this.opts.signer.pubkeyHex < remote) {
			this.opts.onStatus(`peer ${short(remote)} found — initiating`);
			this.makePeer(remote, true);
		} else {
			this.opts.onStatus(`peer ${short(remote)} found — awaiting offer`);
		}
	}

	private async routeSignal(remote: string, signal: PeerSignal): Promise<void> {
		let peer = this.peers.get(remote);
		if (!peer) {
			if (signal.kind !== "offer") return; // only an offer bootstraps a responder
			this.known.add(remote);
			peer = this.makePeer(remote, false);
		}
		await peer.handleSignal(signal);
	}

	private makePeer(remote: string, initiator: boolean): Peer {
		let peer: Peer;
		const { channel, push } = makeChannel((data) => peer.send(data));
		peer = createPeer({
			initiator,
			onSignal: (signal) => void this.publish({ to: remote, ...signal }),
			onMessage: push,
			onOpen: () =>
				this.opts.onPeer({ remotePubkey: remote, initiator, channel, close: () => peer.close() }),
			onClose: () => {
				this.peers.delete(remote);
				this.opts.onStatus(`channel closed with ${short(remote)}`);
			},
		});
		this.peers.set(remote, peer);
		return peer;
	}
}

export type { Mesh };

/** Join the group's relay room and start discovering + connecting to peers. */
export async function joinMesh(opts: MeshOptions): Promise<Mesh> {
	const mesh = new Mesh(opts, await deriveRoomId(opts.groupKey, opts.roomLabel));
	mesh.start();
	return mesh;
}
