// Continuous sync between enrolled devices, no pairing code. In the room (from the
// stored group key) two devices exchange device static pubkeys, verify each is in
// the roster, then run Noise KK (keyed by those statics) to authenticate — a relay
// isn't in the roster, so it can't complete it. Each peer then keeps its channel
// open: it broadcasts its EntriesPayload on connect, on a re-broadcast tick, and
// receives peers' payloads continuously. The local read + merge + write happen in
// the background (fetchLocalPayload / pushRemotePayload), so this stays storage-free.
// See docs/p2p-sync.md.

import type { RosterPayload } from "..";
import type { Channel } from "./channel";
import { type PumpWasm, runInitiator, runResponder } from "./handshake";
import type { PeerSession } from "./mesh";
import type { NostrWasm } from "./nostr-signer";
import { type MeshSession, startMeshSession } from "./peer-session";

/** The Noise KK roster-auth + transport exports. */
interface RosterHandshakeWasm extends PumpWasm {
	handshake_start_initiator(
		privB64: string,
		remotePubB64: string,
	): {
		sessionId: number;
		message: string;
	};
	handshake_start_responder(privB64: string, remotePubB64: string): number;
	handshake_encrypt(sessionId: number, plaintext: string): string;
	handshake_decrypt(sessionId: number, ciphertextB64: string): string;
}

export type RosterSyncWasm = NostrWasm & RosterHandshakeWasm;
type Report = (status: string) => void;

const REBROADCAST_MS = 4000;

export interface RosterSyncOptions {
	relayUrl: string;
	groupKeyB64: string;
	devicePrivB64: string;
	devicePubB64: string;
	roster: RosterPayload;
	wasm: RosterSyncWasm;
	report: Report;
	/** Read this device's current EntriesPayload (JSON) to send to peers. */
	fetchLocalPayload: () => Promise<string>;
	/** Hand a peer's EntriesPayload (JSON) to the background to merge + persist. */
	pushRemotePayload: (json: string) => Promise<void>;
}

interface AuthedPeer {
	channel: Channel;
	sessionId: number;
}

export async function startRosterSync(opts: RosterSyncOptions): Promise<MeshSession> {
	const peers = new Map<string, AuthedPeer>();
	let timer: ReturnType<typeof setInterval> | undefined;
	const session = await startMeshSession({
		relayUrl: opts.relayUrl,
		groupKeyB64: opts.groupKeyB64,
		roomLabel: "bramble/sync",
		wasm: opts.wasm,
		report: opts.report,
		onPeer: (peer) => syncPeer(opts, peer, peers),
		onStop: () => {
			if (timer) clearInterval(timer);
			peers.clear();
		},
	});
	timer = setInterval(() => void broadcast(opts, peers), REBROADCAST_MS);
	opts.report("syncing — listening for peers…");
	return session;
}

function inRoster(roster: RosterPayload, pubkey: string): boolean {
	return roster.devices.some((d) => d.publicKey === pubkey);
}

/** Send our current payload to every authenticated peer (closed channels no-op). */
async function broadcast(opts: RosterSyncOptions, peers: Map<string, AuthedPeer>): Promise<void> {
	if (peers.size === 0) return;
	const payload = await opts.fetchLocalPayload();
	for (const { channel, sessionId } of peers.values()) {
		channel.send(opts.wasm.handshake_encrypt(sessionId, payload));
	}
}

async function syncPeer(
	opts: RosterSyncOptions,
	peer: PeerSession,
	peers: Map<string, AuthedPeer>,
): Promise<void> {
	const { channel } = peer;
	const { wasm, devicePrivB64: priv, devicePubB64: pub } = opts;

	channel.send(pub);
	const peerPub = await channel.recv();
	if (!inRoster(opts.roster, peerPub)) {
		opts.report(`⚠ ${peerPub.slice(0, 8)} not in roster — ignoring`);
		peer.close();
		return;
	}

	const sess =
		pub < peerPub
			? await runInitiator(wasm, channel, () => wasm.handshake_start_initiator(priv, peerPub))
			: await runResponder(wasm, channel, () => wasm.handshake_start_responder(priv, peerPub));
	peers.set(peerPub, { channel, sessionId: sess.sessionId });
	opts.report(`synced with ${peerPub.slice(0, 8)} ✅`);

	channel.send(wasm.handshake_encrypt(sess.sessionId, await opts.fetchLocalPayload()));
	for (;;) {
		const ct = await channel.recv();
		await opts.pushRemotePayload(wasm.handshake_decrypt(sess.sessionId, ct));
	}
}
