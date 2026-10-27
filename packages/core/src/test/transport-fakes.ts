// Fakes for transport tests that run whole sessions with no relay, ICE or WebRTC: an in-memory
// pipe offered as a peer source, and a transport whose Noise is the identity.

import type { RosterPayload } from "../sync";
import {
	type BlobSyncOptions,
	type BlobSyncSession,
	startBlobSync,
	type WantedBlob,
} from "../sync/transport/blob-sync";
import { makeChannel } from "../sync/transport/channel";
import type { PeerSession } from "../sync/transport/mesh";
import type { PeerSource, Stoppable } from "../sync/transport/peer-session";
import type { RosterSyncWasm } from "../sync/transport/roster-sync";
import type { BlobStore } from "../vault/blob-store";

/** The real handshake's two messages, in clear. Signing a relay event throws, so a session that
 * should never touch the relay cannot do so quietly. */
export function identityWasm(): RosterSyncWasm {
	return {
		nostr_generate_key: () => {
			throw new Error("touched the relay despite a local peer source");
		},
		nostr_sign: () => "",
		nostr_verify: () => true,
		handshake_start_initiator: () => ({ sessionId: 1, message: "open" }),
		handshake_start_responder: () => 1,
		handshake_read: (_sid: number, msg: string) =>
			msg === "open" ? { message: "answer", done: true } : { done: true },
		handshake_remote_static: () => "",
		handshake_encrypt: (_sid: number, pt: string) => pt,
		handshake_decrypt: (_sid: number, ct: string) => ct,
	} as unknown as RosterSyncWasm;
}

/** A roster holding exactly these device keys. */
export function rosterOf(pubkeys: string[]): RosterPayload {
	return {
		devices: pubkeys.map((pk, i) => ({
			id: `d${i}`,
			publicKey: pk,
			label: `d${i}`,
			addedAt: 0,
			hlc: { wall: i, counter: 0, node: `d${i}` },
		})),
		revoked: [],
	};
}

/** Two connected ends, "aaaa" (a) and "bbbb" (b), delivering in order. */
export function peerPipe(): { a: PeerSession; b: PeerSession; closed: () => number } {
	let closes = 0;
	let pushA: (d: string) => void = () => {};
	let pushB: (d: string) => void = () => {};
	const endA = makeChannel((d) => pushB(d));
	const endB = makeChannel((d) => pushA(d));
	pushA = endA.push;
	pushB = endB.push;
	const close = () => {
		closes++;
	};
	return {
		a: { remotePubkey: "bbbb", initiator: true, channel: endA.channel, close },
		b: { remotePubkey: "aaaa", initiator: false, channel: endB.channel, close },
		closed: () => closes,
	};
}

/** A peer source that offers one peer, counting how often it is stopped. */
export function sourceFor(peer: PeerSession): { source: PeerSource; stopped: () => number } {
	let stops = 0;
	return {
		source: async ({ onPeer }) => {
			onPeer(peer);
			return {
				stop: () => {
					stops++;
				},
			} satisfies Stoppable;
		},
		stopped: () => stops,
	};
}

/** A file session for "aaaa" or "bbbb" over one local source: no relay, identity Noise, and a
 * manifest naming exactly `wanted`. */
export function testBlobSession(
	pub: string,
	source: PeerSource,
	blobs: BlobStore,
	wanted: WantedBlob[],
	extra: Partial<BlobSyncOptions> = {},
): Promise<BlobSyncSession> {
	return startBlobSync({
		relayUrl: "wss://relay.invalid",
		groupKeyB64: "unused",
		devicePrivB64: `priv-${pub}`,
		devicePubB64: pub,
		roster: rosterOf(["aaaa", "bbbb"]),
		wasm: identityWasm(),
		report: () => {},
		blobs,
		wanted: async () => wanted,
		relay: false,
		localSources: [source],
		...extra,
	});
}
