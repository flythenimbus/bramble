// Continuous sync between enrolled devices, no pairing code. In the room (from the
// stored group key) two devices exchange device static pubkeys, verify each is in
// the roster, then run Noise KK (keyed by those statics) to authenticate — a relay
// isn't in the roster, so it can't complete it. Each peer then keeps its channel
// open: it broadcasts its EntriesPayload on connect, on a re-broadcast tick, and
// receives peers' payloads continuously. The local read + merge + write happen in
// the background (fetchLocalPayload / pushRemotePayload), so this stays storage-free.
// See docs/p2p-sync.md.

import { decodeRoster, type RosterPayload } from "..";
import type { Channel } from "./channel";
import { type Awaitable, type PumpWasm, runInitiator, runResponder } from "./handshake";
import type { PeerSession } from "./mesh";
import type { NostrWasm } from "./nostr-signer";
import { type MeshSession, startMeshSession } from "./peer-session";

/** The Noise KK roster-auth + transport exports. Returns are Awaitable so the native
 * plugin (async bridge) and the in-webview WASM module share one interface. */
interface RosterHandshakeWasm extends PumpWasm {
	handshake_start_initiator(
		privB64: string,
		remotePubB64: string,
	): Awaitable<{
		sessionId: number;
		message: string;
	}>;
	handshake_start_responder(privB64: string, remotePubB64: string): Awaitable<number>;
	handshake_encrypt(sessionId: number, plaintext: string): Awaitable<string>;
	handshake_decrypt(sessionId: number, ciphertextB64: string): Awaitable<string>;
}

export type RosterSyncWasm = NostrWasm & RosterHandshakeWasm;
type Report = (status: string) => void;

const REBROADCAST_MS = 4000;
// The relay is best-effort live fan-out (ephemeral, no store), so a frame dropped mid
// handshake would hang recv() forever. Bound the handshake; on timeout we abandon this
// attempt and the periodic resume (Firefox keep-alive / a peer's re-announce) retries.
// The post-handshake receive loop is intentionally unbounded (it idles between changes).
const HANDSHAKE_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
	});
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface RosterSyncOptions {
	relayUrl: string;
	iceUrl?: string;
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
	/** Read this device's roster (JSON) to gossip alongside entries, so revocations propagate. */
	fetchLocalRoster?: () => Promise<string>;
	/** Merge a peer's roster (JSON) into the local one + persist. */
	pushRemoteRoster?: (json: string) => Promise<void>;
}

/** What a peer broadcast carries: entries always, the roster when wired. */
interface SyncEnvelope {
	entries: string;
	roster?: string;
}

async function localEnvelope(opts: RosterSyncOptions): Promise<string> {
	const entries = await opts.fetchLocalPayload();
	const roster = opts.fetchLocalRoster ? await opts.fetchLocalRoster() : undefined;
	return JSON.stringify({ entries, roster } satisfies SyncEnvelope);
}

async function applyEnvelope(opts: RosterSyncOptions, json: string): Promise<void> {
	let env: SyncEnvelope;
	try {
		env = JSON.parse(json) as SyncEnvelope;
	} catch {
		return;
	}
	if (env.roster && opts.pushRemoteRoster) await opts.pushRemoteRoster(env.roster);
	if (env.entries) await opts.pushRemotePayload(env.entries);
}

interface AuthedPeer {
	channel: Channel;
	sessionId: number;
	/** Wall-clock of the last received envelope; drives stale reaping. */
	lastSeen: number;
	/** Reap: stop the receive loop and tear down the transport. */
	close: () => void;
}

// Relay-forward has no connection-liveness signal, so a peer that went away (e.g. a
// Firefox device that suspended and restarted with a fresh identity) would linger in the
// map and be broadcast to forever. Healthy peers re-broadcast every REBROADCAST_MS, so
// treat one silent for several ticks as gone.
const STALE_MS = 5 * REBROADCAST_MS;

export async function startRosterSync(opts: RosterSyncOptions): Promise<MeshSession> {
	const peers = new Map<string, AuthedPeer>();
	let timer: ReturnType<typeof setInterval> | undefined;
	const session = await startMeshSession({
		relayUrl: opts.relayUrl,
		iceUrl: opts.iceUrl,
		groupKeyB64: opts.groupKeyB64,
		roomLabel: "bramble/sync",
		wasm: opts.wasm,
		report: opts.report,
		epochRooms: true, // rotate the (long-lived, high-traffic) sync room per epoch
		onPeer: (peer) => syncPeer(opts, peer, peers),
		onStop: () => {
			if (timer) clearInterval(timer);
			for (const peer of peers.values()) peer.close();
			peers.clear();
		},
	});
	timer = setInterval(() => {
		reapStale(opts, peers);
		void broadcast(opts, peers);
	}, REBROADCAST_MS);
	opts.report("syncing — listening for peers…");
	return session;
}

function inRoster(roster: RosterPayload, pubkey: string): boolean {
	return roster.devices.some((d) => d.publicKey === pubkey);
}

/** The CURRENT roster membership, read fresh each time (fetchLocalRoster hits storage) so a
 * revocation takes effect on a live session instead of at the next lock/unlock. Falls back to
 * the initial snapshot when fetchLocalRoster is not wired or returns something unparseable.
 * Exported for tests. */
export async function currentRoster(
	opts: Pick<RosterSyncOptions, "roster" | "fetchLocalRoster">,
): Promise<RosterPayload> {
	if (!opts.fetchLocalRoster) return opts.roster;
	try {
		return decodeRoster(await opts.fetchLocalRoster());
	} catch {
		return opts.roster;
	}
}

/** Drop (and tear down) peers no longer active in `roster` — a device revoked mid-session.
 * Closing the peer also breaks its receive loop, so a revoked device loses access in both
 * directions without waiting for a relock. Exported for tests. */
export function reapRevoked(
	opts: Pick<RosterSyncOptions, "report">,
	peers: Map<string, AuthedPeer>,
	roster: RosterPayload,
): void {
	for (const [pub, peer] of peers) {
		if (!inRoster(roster, pub)) {
			opts.report(`peer ${pub.slice(0, 8)} revoked — disconnecting`);
			peer.close();
			peers.delete(pub);
		}
	}
}

/** Send our current payload to every authenticated peer (closed channels no-op). */
async function broadcast(opts: RosterSyncOptions, peers: Map<string, AuthedPeer>): Promise<void> {
	if (peers.size === 0) return;
	// Enforce revocation on the live session before sending: a device revoked since the session
	// started must stop receiving our vault now, not at the next lock/unlock.
	reapRevoked(opts, peers, await currentRoster(opts));
	if (peers.size === 0) return;
	const payload = await localEnvelope(opts);
	for (const { channel, sessionId } of peers.values()) {
		channel.send(await opts.wasm.handshake_encrypt(sessionId, payload));
	}
}

/** Drop peers that have gone silent past STALE_MS (see AuthedPeer). Exported for tests. */
export function reapStale(
	opts: Pick<RosterSyncOptions, "report">,
	peers: Map<string, AuthedPeer>,
	now: number = Date.now(),
): void {
	for (const [pub, peer] of peers) {
		if (now - peer.lastSeen > STALE_MS) {
			opts.report(`peer ${pub.slice(0, 8)} idle — dropping`);
			peer.close();
			peers.delete(pub);
		}
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
	let peerPub: string;
	let sess: { sessionId: number };
	try {
		peerPub = await withTimeout(channel.recv(), HANDSHAKE_TIMEOUT_MS, "roster-auth");
		// Gate on the CURRENT roster (read fresh), so a device revoked since this session started
		// cannot (re-)authenticate against a stale snapshot.
		if (!inRoster(await currentRoster(opts), peerPub)) {
			opts.report(`⚠ ${peerPub.slice(0, 8)} not in roster — ignoring`);
			peer.close();
			return;
		}
		sess = await withTimeout(
			pub < peerPub
				? runInitiator(wasm, channel, () => wasm.handshake_start_initiator(priv, peerPub))
				: runResponder(wasm, channel, () => wasm.handshake_start_responder(priv, peerPub)),
			HANDSHAKE_TIMEOUT_MS,
			"handshake",
		);
	} catch (e) {
		// A stalled/failed handshake: abandon this attempt cleanly instead of hanging.
		opts.report(`handshake failed: ${(e as Error).message}`);
		peer.close();
		return;
	}
	let wakeAbort: (() => void) | null = null;
	const aborted = new Promise<null>((resolve) => {
		wakeAbort = () => resolve(null);
	});
	const entry: AuthedPeer = {
		channel,
		sessionId: sess.sessionId,
		lastSeen: Date.now(),
		close: () => {
			wakeAbort?.();
			peer.close();
		},
	};
	peers.set(peerPub, entry);
	opts.report(`synced with ${peerPub.slice(0, 8)} ✅`);

	channel.send(await wasm.handshake_encrypt(sess.sessionId, await localEnvelope(opts)));
	for (;;) {
		// Race the (unbounded) receive against reaping, so a dropped peer's loop exits
		// instead of leaking a pending recv() forever (relay channels have no close event).
		const ct = await Promise.race([channel.recv(), aborted]);
		if (ct === null) break;
		entry.lastSeen = Date.now();
		await applyEnvelope(opts, await wasm.handshake_decrypt(sess.sessionId, ct));
	}
}
