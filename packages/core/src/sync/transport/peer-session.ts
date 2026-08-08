// One authenticated mesh session: join the group's relay room, hand each connected
// peer to onPeer, and tear the whole thing down (plus any caller cleanup) on stop().
// Enrollment and ongoing sync are each a configuration of this. The session is
// returned as a handle the caller holds, not a module-level singleton, so both
// flows stay testable with a fake mesh. See docs/p2p-sync.md.

import { base64ToBytes } from "../../util/bytes";
import { deriveIceUrl, fetchIceServers } from "./ice";
import { joinMesh, type Mesh, type MeshOptions, type PeerSession } from "./mesh";
import { makeNostr, type NostrWasm } from "./nostr-signer";

/** The slice of the mesh a session drives: just teardown. */
export interface Stoppable {
	stop(): void;
}

/**
 * Where peers come from. The relay mesh is the default and the only one that finds devices it
 * has never met; a host that ALREADY holds an authenticated pipe to a peer supplies its own.
 *
 * The desktop app and a browser extension on the same machine are the case this exists for: they
 * are joined by a native-messaging pipe, so routing their traffic out to a relay and back through
 * WebRTC is a round trip through the internet between two processes that can already talk. A
 * local source also works with no network at all.
 *
 * Everything above this line is unchanged either way. A peer is a Channel plus an identity, and
 * roster-auth, the Noise KK handshake and the envelope exchange all run on top of it, so a local
 * peer is authenticated and revocable by exactly the same rules as a remote one.
 */
export type PeerSource = (handlers: {
	onPeer: (peer: PeerSession) => void;
	report: (status: string) => void;
}) => Promise<Stoppable>;

export interface MeshSession {
	/** Tear down the mesh and run the caller's onStop. Safe to call more than once. */
	stop(): void;
	/** Push this device's current payload to all peers now, rather than waiting for the rebroadcast
	 * tick. Populated by roster-sync (ongoing sync); enrollment sessions omit it. */
	broadcastNow?(): Promise<void>;
}

export interface MeshSessionOptions {
	relayUrl: string;
	groupKeyB64: string;
	/** Separate rooms keep enrollment and ongoing sync from colliding. */
	roomLabel: string;
	/** Empty/undefined derives the ICE endpoint from the relay URL. */
	iceUrl?: string;
	wasm: NostrWasm;
	report: (status: string) => void;
	/** Rotate the room per epoch (ongoing sync); off for the brief enrollment room. */
	epochRooms?: boolean;
	/** Handle one authenticated peer (run the handshake + the role's phase). */
	onPeer: (peer: PeerSession) => Promise<void>;
	/** Caller cleanup beyond the mesh, e.g. a re-broadcast timer. Run once on stop(). */
	onStop?: () => void;
	/** The mesh joiner; overridden in tests with a fake. */
	join?: (opts: MeshOptions) => Promise<Stoppable>;
	fetchIce?: (iceUrl: string) => Promise<RTCIceServer[]>;
	/** Take peers from here instead of the relay mesh. `relayUrl`, `groupKeyB64`, `iceUrl` and
	 * `roomLabel` are then unused: there is no room to join and no signalling to do. */
	peerSource?: PeerSource;
}

export async function startMeshSession(opts: MeshSessionOptions): Promise<MeshSession> {
	// A supplied source already has its peers, so nothing below applies: no ICE to fetch, no room
	// to join, no group key on the wire. Returned before any of it runs rather than after, so a
	// local session never touches the network.
	if (opts.peerSource) {
		const source = await opts.peerSource({
			onPeer: (peer) =>
				void opts.onPeer(peer).catch((e) => opts.report(`peer error: ${String(e)}`)),
			report: opts.report,
		});
		let sourceStopped = false;
		return {
			stop() {
				if (sourceStopped) return;
				sourceStopped = true;
				opts.onStop?.();
				source.stop();
			},
		};
	}
	const join: (opts: MeshOptions) => Promise<Stoppable> = opts.join ?? joinMesh;
	const fetchIce = opts.fetchIce ?? fetchIceServers;
	const iceServers = await fetchIce(opts.iceUrl || deriveIceUrl(opts.relayUrl));
	opts.report(iceServers.length ? "ICE: relay servers ready" : "ICE: direct (host) only");
	const mesh = await join({
		relayUrl: opts.relayUrl,
		groupKey: base64ToBytes(opts.groupKeyB64),
		roomLabel: opts.roomLabel,
		signer: await makeNostr(opts.wasm),
		iceServers,
		epochRooms: opts.epochRooms,
		onStatus: opts.report,
		onPeer: (peer) => void opts.onPeer(peer).catch((e) => opts.report(`peer error: ${String(e)}`)),
	});
	let stopped = false;
	return {
		stop() {
			if (stopped) return;
			stopped = true;
			opts.onStop?.();
			mesh.stop();
		},
	};
}

export type { Mesh, PeerSession };
