// The authentication every ongoing session runs on a fresh peer, whatever it then carries: swap
// device static keys, check the peer is in the CURRENT roster, then complete Noise KK keyed by
// those statics. A relay is not in the roster, so it can never complete it. Shared by entry sync
// and blob sync so the two cannot drift into two ideas of who may connect. See docs/p2p-sync.md.

import { withTimeout } from "../../util/with-timeout";
import { decodeRoster, type RosterPayload } from "..";
import { type Awaitable, type PumpWasm, runInitiator, runResponder } from "./handshake";
import type { PeerSession } from "./mesh";

/** The Noise KK roster-auth + transport exports. Returns are Awaitable so the native
 * plugin (async bridge) and the in-webview WASM module share one interface. */
export interface RosterHandshakeWasm extends PumpWasm {
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

// The relay is best-effort live fan-out (ephemeral, no store), so a frame dropped mid
// handshake would hang recv() forever. Bound the handshake; on timeout we abandon this
// attempt and the periodic resume (Firefox keep-alive / a peer's re-announce) retries.
const HANDSHAKE_TIMEOUT_MS = 15_000;

export interface PeerAuthOptions {
	devicePrivB64: string;
	devicePubB64: string;
	roster: RosterPayload;
	/** Read this device's roster (JSON), so a revocation applies to a live session. */
	fetchLocalRoster?: () => Promise<string>;
	wasm: RosterHandshakeWasm;
	report: (status: string) => void;
}

export function inRoster(roster: RosterPayload, pubkey: string): boolean {
	return roster.devices.some((d) => d.publicKey === pubkey);
}

/** The CURRENT roster membership, read fresh each time (fetchLocalRoster hits storage) so a
 * revocation takes effect on a live session instead of at the next lock/unlock. Falls back to
 * the initial snapshot when fetchLocalRoster is not wired or returns something unparseable. */
export async function currentRoster(
	opts: Pick<PeerAuthOptions, "roster" | "fetchLocalRoster">,
): Promise<RosterPayload> {
	if (!opts.fetchLocalRoster) return opts.roster;
	try {
		return decodeRoster(await opts.fetchLocalRoster());
	} catch {
		return opts.roster;
	}
}

/**
 * Authenticate one peer. Resolves with its device key and the Noise session, or null (with the
 * peer closed and the reason reported) for a peer not in the roster or a handshake that failed.
 */
export async function authenticatePeer(
	opts: PeerAuthOptions,
	peer: PeerSession,
): Promise<{ peerPub: string; sessionId: number } | null> {
	const { channel } = peer;
	const { wasm, devicePrivB64: priv, devicePubB64: pub } = opts;
	channel.send(pub);
	try {
		const peerPub = await withTimeout(channel.recv(), HANDSHAKE_TIMEOUT_MS, "roster-auth");
		// Gate on the CURRENT roster (read fresh), so a device revoked since this session started
		// cannot (re-)authenticate against a stale snapshot.
		if (!inRoster(await currentRoster(opts), peerPub)) {
			opts.report(`⚠ ${peerPub.slice(0, 8)} not in roster, ignoring`);
			peer.close();
			return null;
		}
		const sess = await withTimeout(
			pub < peerPub
				? runInitiator(wasm, channel, () => wasm.handshake_start_initiator(priv, peerPub))
				: runResponder(wasm, channel, () => wasm.handshake_start_responder(priv, peerPub)),
			HANDSHAKE_TIMEOUT_MS,
			"handshake",
		);
		return { peerPub, sessionId: sess.sessionId };
	} catch (e) {
		// A stalled/failed handshake: abandon this attempt cleanly instead of hanging.
		opts.report(`handshake failed: ${(e as Error).message}`);
		peer.close();
		return null;
	}
}
