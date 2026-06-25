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

export interface MeshSession {
	/** Tear down the mesh and run the caller's onStop. Safe to call more than once. */
	stop(): void;
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
	/** Handle one authenticated peer (run the handshake + the role's phase). */
	onPeer: (peer: PeerSession) => Promise<void>;
	/** Caller cleanup beyond the mesh, e.g. a re-broadcast timer. Run once on stop(). */
	onStop?: () => void;
	/** The mesh joiner; overridden in tests with a fake. */
	join?: (opts: MeshOptions) => Promise<Stoppable>;
	fetchIce?: (iceUrl: string) => Promise<RTCIceServer[]>;
}

export async function startMeshSession(opts: MeshSessionOptions): Promise<MeshSession> {
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
