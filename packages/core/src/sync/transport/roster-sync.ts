// Continuous sync between enrolled devices, no pairing code. In the room (from the
// stored group key) two devices exchange device static pubkeys, verify each is in
// the roster, then run Noise KK (keyed by those statics) to authenticate — a relay
// isn't in the roster, so it can't complete it. Each peer then keeps its channel
// open: it broadcasts its EntriesPayload on connect, on a re-broadcast tick, and
// receives peers' payloads continuously. The local read + merge + write happen in
// the background (fetchLocalPayload / pushRemotePayload), so this stays storage-free.
// See docs/p2p-sync.md.

import { flags } from "../../flags";
import {
	canonicalRosterEntry,
	decodeRoster,
	encodeRoster,
	type RosterEntry,
	type RosterPayload,
	verifyRemoteRoster,
} from "..";
import type { Channel } from "./channel";
import type { Awaitable } from "./handshake";
import type { PeerSession } from "./mesh";
import type { NostrWasm } from "./nostr-signer";
import { authenticatePeer, currentRoster, inRoster, type RosterHandshakeWasm } from "./peer-auth";
import { type MeshSession, type PeerSource, startMeshSession } from "./peer-session";
import { recvSecure, sendSecure } from "./secure-channel";

/** Ed25519 roster-entry verification (Item A). Optional: absent on hosts not yet wired for roster
 * signing (e.g. an older mobile native-crypto shim), where verification degrades to
 * verify-if-present (pass-through). See docs/p2p-sync-revocation-hardening.md. */
interface RosterVerifyWasm {
	roster_verify?(publicB64: string, message: string, sigB64: string): Awaitable<boolean>;
}

export type RosterSyncWasm = NostrWasm & RosterHandshakeWasm & RosterVerifyWasm;
type Report = (status: string) => void;

const REBROADCAST_MS = 4000;
/**
 * What an unchanged tick carries instead of the whole envelope: it keeps the peer from being
 * reaped and applies nothing, since every version skips an envelope with neither `entries` nor
 * `roster`. Over TURN the whole vault every 4 s was most of the metered traffic. See
 * docs/sync-rebroadcast.md.
 */
const HEARTBEAT = "{}";
/** What a receiver sends when a merge failed: the sender's next tick then carries everything. */
const RESEND = JSON.stringify({ resend: true });
/** The whole envelope goes out this often regardless, for a loss nobody noticed. */
const FULL_RESEND_MS = 10 * 60_000;

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
	/** Take peers from here rather than the relay mesh. See PeerSource. */
	peerSource?: PeerSource;
}

/** What a peer broadcast carries: entries and the roster when it changed, nothing on a heartbeat,
 * and `resend` from a receiver asking for everything again. */
interface SyncEnvelope {
	entries?: string;
	roster?: string;
	resend?: boolean;
}

async function localEnvelope(opts: RosterSyncOptions): Promise<string> {
	const entries = await opts.fetchLocalPayload();
	const roster = opts.fetchLocalRoster ? await opts.fetchLocalRoster() : undefined;
	return JSON.stringify({ entries, roster } satisfies SyncEnvelope);
}

/** Merge what a peer sent. True when it asked for the whole envelope again. Rejects when a merge
 * fails, so the receive loop can ask for it again: nothing else will resend it. */
async function applyEnvelope(
	opts: RosterSyncOptions,
	json: string,
	local: RosterPayload,
): Promise<boolean> {
	let env: SyncEnvelope;
	try {
		env = JSON.parse(json) as SyncEnvelope;
	} catch {
		return false;
	}
	if (env.resend === true) return true;
	if (env.roster && opts.pushRemoteRoster) {
		const verified = await verifyRosterEnvelope(opts, env.roster, local);
		if (verified !== null) await opts.pushRemoteRoster(verified);
	}
	if (env.entries) await opts.pushRemotePayload(env.entries);
	return false;
}

/** Verify a gossiped roster before it is pushed to merge (Item A): drop entries that fail Ed25519
 * verification or violate the TOFU id->key binding, so a compromised member cannot impersonate
 * another device. Returns the cleaned roster JSON, or null if it cannot be parsed. Degrades to
 * pass-through when the host is not wired for verification (roster_verify absent), preserving
 * verify-if-present. Exported for tests. See docs/p2p-sync-revocation-hardening.md. */
export async function verifyRosterEnvelope(
	opts: Pick<RosterSyncOptions, "roster" | "fetchLocalRoster" | "wasm">,
	rosterJson: string,
	local?: RosterPayload,
): Promise<string | null> {
	let remote: RosterPayload;
	try {
		remote = decodeRoster(rosterJson);
	} catch {
		return null;
	}
	const rosterVerify = opts.wasm.roster_verify;
	if (!rosterVerify) return rosterJson; // host not wired for verification: verify-if-present passes.
	const current = local ?? (await currentRoster(opts));
	const valid = new Set<RosterEntry>(); // valid self-signature (keyed by object identity)
	const validAdmission = new Set<RosterEntry>(); // valid admission by a current member
	for (const entry of remote.devices) {
		if (entry.sigKey && entry.sig) {
			try {
				if (await rosterVerify(entry.sigKey, canonicalRosterEntry(entry), entry.sig))
					valid.add(entry);
			} catch {
				// A verification error is a failed signature: fail closed (leave out of `valid`).
			}
		}
		// An admission is valid iff a CURRENT live member (the admitter) signed this entry with its
		// published admission key. A compromised member without the password can't produce one.
		if (entry.admission) {
			const admitter = current.devices.find((d) => d.id === entry.admission?.by);
			if (admitter?.admissionKey) {
				try {
					if (
						await rosterVerify(
							admitter.admissionKey,
							canonicalRosterEntry(entry),
							entry.admission.sig,
						)
					)
						validAdmission.add(entry);
				} catch {
					// failed admission signature -> not in validAdmission
				}
			}
		}
	}
	return encodeRoster(
		verifyRemoteRoster(
			current,
			remote,
			(entry) => valid.has(entry),
			(entry) => validAdmission.has(entry),
			{ signatures: flags.rosterRequireSignatures, admission: flags.rosterRequireAdmission },
		),
	);
}

interface AuthedPeer {
	channel: Channel;
	sessionId: number;
	/** Wall-clock of the last received envelope; drives stale reaping. */
	lastSeen: number;
	/** Reap: stop the receive loop and tear down the transport. */
	close: () => void;
	/** Send one message once the last is out: two at once would interleave their Noise frames. */
	send: (json: string) => Promise<void>;
	/** The last whole envelope this peer was sent; null sends the whole one next tick. */
	lastSent: string | null;
	/** When it was sent, for FULL_RESEND_MS. */
	lastFullAt: number;
}

/** What the reapers need of a peer. */
type Reapable = Pick<AuthedPeer, "lastSeen" | "close">;

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
		peerSource: opts.peerSource,
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
	// broadcastNow lets the host push a local edit the instant it lands (see SYNC_BROADCAST_NOW)
	// instead of waiting up to REBROADCAST_MS — important where the host suspends between ticks.
	return { ...session, broadcastNow: () => broadcast(opts, peers) };
}

/** Drop (and tear down) peers no longer active in `roster` — a device revoked mid-session.
 * Closing the peer also breaks its receive loop, so a revoked device loses access in both
 * directions without waiting for a relock. Exported for tests. */
export function reapRevoked(
	opts: Pick<RosterSyncOptions, "report">,
	peers: Map<string, Reapable>,
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

/** Send every authenticated peer our envelope if it changed since it last got one, and a
 * heartbeat if not (closed channels no-op). */
async function broadcast(opts: RosterSyncOptions, peers: Map<string, AuthedPeer>): Promise<void> {
	if (peers.size === 0) return;
	// Enforce revocation on the live session before sending: a device revoked since the session
	// started must stop receiving our vault now, not at the next lock/unlock.
	reapRevoked(opts, peers, await currentRoster(opts));
	if (peers.size === 0) return;
	// Built every tick, as before: comparing is what notices an edit on a host that doesn't push
	// one (desktop, mobile) and a merge that changed the vault for the other peers.
	const envelope = await localEnvelope(opts);
	const now = Date.now();
	for (const peer of peers.values()) {
		const whole = peer.lastSent !== envelope || now - peer.lastFullAt >= FULL_RESEND_MS;
		if (whole) {
			peer.lastSent = envelope;
			peer.lastFullAt = now;
		}
		await peer.send(whole ? envelope : HEARTBEAT);
	}
}

/** Drop peers that have gone silent past STALE_MS (see AuthedPeer). Exported for tests. */
export function reapStale(
	opts: Pick<RosterSyncOptions, "report">,
	peers: Map<string, Reapable>,
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
	const { wasm } = opts;
	const authed = await authenticatePeer(opts, peer);
	if (!authed) return;
	const { peerPub } = authed;
	const sess = { sessionId: authed.sessionId };
	let wakeAbort: (() => void) | null = null;
	const aborted = new Promise<null>((resolve) => {
		wakeAbort = () => resolve(null);
	});
	let sendTail: Promise<void> = Promise.resolve();
	const entry: AuthedPeer = {
		channel,
		sessionId: sess.sessionId,
		lastSeen: Date.now(),
		close: () => {
			wakeAbort?.();
			peer.close();
		},
		send: (json) => {
			const run = sendTail.then(() => sendSecure(channel, wasm, sess.sessionId, json));
			sendTail = run.catch(() => {});
			return run;
		},
		lastSent: null,
		lastFullAt: 0,
	};
	peers.set(peerPub, entry);
	opts.report(`synced with ${peerPub.slice(0, 8)} ✅`);

	const first = await localEnvelope(opts);
	entry.lastSent = first;
	entry.lastFullAt = Date.now();
	await entry.send(first);
	// Race each frame's (unbounded) receive against reaping, so a dropped peer's loop exits
	// instead of leaking a pending recv() forever (relay channels have no close event).
	const recvFrame = () => Promise.race([channel.recv(), aborted]);
	for (;;) {
		// recvSecure reassembles an envelope that spans multiple Noise frames (large vault).
		const envelope = await recvSecure(recvFrame, wasm, sess.sessionId);
		if (envelope === null) break;
		entry.lastSeen = Date.now();
		// Refuse inbound from a peer revoked since the handshake: don't apply its data.
		const roster = await currentRoster(opts);
		if (!inRoster(roster, peerPub)) {
			entry.close();
			peers.delete(peerPub);
			break;
		}
		try {
			// Asked for everything again: the next tick sends the whole envelope.
			if (await applyEnvelope(opts, envelope, roster)) entry.lastSent = null;
		} catch (e) {
			// The sender won't send this again unless asked, so ask, and keep the session.
			opts.report(`merge from ${peerPub.slice(0, 8)} failed, asking again: ${String(e)}`);
			await entry.send(RESEND).catch(() => {});
		}
		// The envelope may have gossiped a revocation of another peer; drop it now rather than
		// waiting for the next re-broadcast tick, so a revocation propagates across the mesh at once.
		// Fresh read, not the copy above: the merge can outlast an enrollment finishing elsewhere,
		// and reaping against the pre-merge copy would close the joiner as if it were revoked.
		reapRevoked(opts, peers, await currentRoster(opts));
	}
}
