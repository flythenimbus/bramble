import { describe, expect, it, vi } from "vitest";
import { identityWasm, peerPipe, rosterOf, sourceFor } from "../../test/transport-fakes";
import { startRosterSync } from "./roster-sync";

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

/** A source that hands over one already-connected peer, as a local pipe does. */

/**
 * Identity transport with a two-message handshake, so both roles complete against each other.
 *
 * The responder answers the initiator's opener and is then done; the initiator consumes that
 * answer and is done. Role-free, so one object serves both ends.
 */

const PAIR = rosterOf(["aaaa", "bbbb"]);
const entriesOf = (marker: string) => JSON.stringify({ entries: [{ marker }], tombstones: [] });

describe("sync over a supplied peer source", () => {
	it("exchanges payloads between two devices with no relay and no WebRTC", async () => {
		const link = peerPipe();
		const gotByA: string[] = [];
		const gotByB: string[] = [];

		// "aaaa" sorts below "bbbb", so it takes the initiator role; the pipe does not care.
		const a = await startRosterSync({
			relayUrl: "wss://relay.invalid",
			groupKeyB64: "unused",
			devicePrivB64: "privA",
			devicePubB64: "aaaa",
			roster: PAIR,
			wasm: identityWasm(),
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
			wasm: identityWasm(),
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
		const link = peerPipe();
		const applied: string[] = [];

		const a = await startRosterSync({
			relayUrl: "wss://relay.invalid",
			groupKeyB64: "unused",
			devicePrivB64: "privA",
			devicePubB64: "aaaa",
			roster: rosterOf(["aaaa"]), // "bbbb" was never admitted
			wasm: identityWasm(),
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
			wasm: identityWasm(),
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
		const link = peerPipe();
		const src = sourceFor(link.a);
		const session = await startRosterSync({
			relayUrl: "wss://relay.invalid",
			groupKeyB64: "unused",
			devicePrivB64: "privA",
			devicePubB64: "aaaa",
			roster: PAIR,
			wasm: identityWasm(),
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
