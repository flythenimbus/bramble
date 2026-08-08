import { describe, expect, it, vi } from "vitest";
import type { RosterPayload } from "..";
import { makeChannel } from "./channel";
import type { PeerSession } from "./mesh";
import type { PeerSource, Stoppable } from "./peer-session";
import { type RosterSyncWasm, startRosterSync } from "./roster-sync";

// A session built on a supplied PeerSource must never reach the network: the whole point is that
// two processes on one machine (the desktop app and a browser extension) already have a pipe, so
// routing their traffic to a relay and back through WebRTC is a trip through the internet to reach
// the next process along. These mocks turn "it quietly fell back to the relay" from a slow test
// into a failing one.
vi.mock("./mesh", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mesh")>()),
	joinMesh: () => {
		throw new Error("joined the relay mesh despite a peerSource");
	},
}));
vi.mock("./ice", async (importOriginal) => ({
	...(await importOriginal<typeof import("./ice")>()),
	fetchIceServers: () => {
		throw new Error("fetched ICE servers despite a peerSource");
	},
}));

/**
 * Two Channels wired to each other, standing in for the native-messaging pipe.
 *
 * Sends are synchronous and queue until the far side calls recv(), which is what the real pipe
 * does too: frames arrive whether or not anyone is waiting for them yet.
 */
function pipe(): { a: PeerSession; b: PeerSession; closed: () => number } {
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

/** A source that hands over one already-connected peer, as a local pipe does. */
function sourceFor(peer: PeerSession): { source: PeerSource; stopped: () => number } {
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

/**
 * Identity transport with a two-message handshake, so both roles complete against each other.
 *
 * The responder answers the initiator's opener and is then done; the initiator consumes that
 * answer and is done. Role-free, so one object serves both ends.
 */
function wasm(): RosterSyncWasm {
	return {
		nostr_generate_key: () => {
			throw new Error("signed a relay event despite a peerSource");
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

const roster = (pubkeys: string[]): RosterPayload => ({
	devices: pubkeys.map((pk, i) => ({
		id: `d${i}`,
		publicKey: pk,
		label: `d${i}`,
		addedAt: 0,
		hlc: { wall: i, counter: 0, node: `d${i}` },
	})),
	revoked: [],
});

const PAIR = roster(["aaaa", "bbbb"]);
const entriesOf = (marker: string) => JSON.stringify({ entries: [{ marker }], tombstones: [] });

describe("sync over a supplied peer source", () => {
	it("exchanges payloads between two devices with no relay and no WebRTC", async () => {
		const link = pipe();
		const gotByA: string[] = [];
		const gotByB: string[] = [];

		// "aaaa" sorts below "bbbb", so it takes the initiator role; the pipe does not care.
		const a = await startRosterSync({
			relayUrl: "wss://relay.invalid",
			groupKeyB64: "unused",
			devicePrivB64: "privA",
			devicePubB64: "aaaa",
			roster: PAIR,
			wasm: wasm(),
			report: () => {},
			fetchLocalPayload: async () => entriesOf("from-a"),
			pushRemotePayload: async (json) => {
				gotByA.push(json);
			},
			peerSource: sourceFor(link.a).source,
		});
		const b = await startRosterSync({
			relayUrl: "wss://relay.invalid",
			groupKeyB64: "unused",
			devicePrivB64: "privB",
			devicePubB64: "bbbb",
			roster: PAIR,
			wasm: wasm(),
			report: () => {},
			fetchLocalPayload: async () => entriesOf("from-b"),
			pushRemotePayload: async (json) => {
				gotByB.push(json);
			},
			peerSource: sourceFor(link.b).source,
		});

		// Each side sends its payload once authenticated, so both land without a broadcast tick.
		await vi.waitFor(() => {
			expect(gotByA.length).toBeGreaterThan(0);
			expect(gotByB.length).toBeGreaterThan(0);
		});
		expect(gotByA[0]).toContain("from-b");
		expect(gotByB[0]).toContain("from-a");

		a.stop();
		b.stop();
	});

	it("refuses a peer that is not in the roster, whatever pipe it arrived on", async () => {
		// A local pipe is not an authorization. Being on the same machine as the app says nothing
		// about being a member of the vault's group, and revocation has to bite here too.
		const link = pipe();
		const applied: string[] = [];

		const a = await startRosterSync({
			relayUrl: "wss://relay.invalid",
			groupKeyB64: "unused",
			devicePrivB64: "privA",
			devicePubB64: "aaaa",
			roster: roster(["aaaa"]), // "bbbb" was never admitted
			wasm: wasm(),
			report: () => {},
			fetchLocalPayload: async () => entriesOf("from-a"),
			pushRemotePayload: async (json) => {
				applied.push(json);
			},
			peerSource: sourceFor(link.a).source,
		});
		const b = await startRosterSync({
			relayUrl: "wss://relay.invalid",
			groupKeyB64: "unused",
			devicePrivB64: "privB",
			devicePubB64: "bbbb",
			roster: PAIR,
			wasm: wasm(),
			report: () => {},
			fetchLocalPayload: async () => entriesOf("from-b"),
			pushRemotePayload: async () => {},
			peerSource: sourceFor(link.b).source,
		});

		await vi.waitFor(() => expect(link.closed()).toBeGreaterThan(0));
		expect(applied).toEqual([]);

		a.stop();
		b.stop();
	});

	it("stops the source on teardown, so the pipe does not outlive the session", async () => {
		const link = pipe();
		const src = sourceFor(link.a);
		const session = await startRosterSync({
			relayUrl: "wss://relay.invalid",
			groupKeyB64: "unused",
			devicePrivB64: "privA",
			devicePubB64: "aaaa",
			roster: PAIR,
			wasm: wasm(),
			report: () => {},
			fetchLocalPayload: async () => entriesOf("from-a"),
			pushRemotePayload: async () => {},
			peerSource: src.source,
		});

		session.stop();
		expect(src.stopped()).toBe(1);
		// Idempotent, as the mesh path is: a second stop from a different teardown path is normal.
		session.stop();
		expect(src.stopped()).toBe(1);
	});
});
