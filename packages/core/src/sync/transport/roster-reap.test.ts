import { describe, expect, it, vi } from "vitest";
import { identityWasm, rosterOf } from "../../test/transport-fakes";
import { encodeRoster } from "..";
import { makeChannel } from "./channel";
import type { PeerSession } from "./mesh";
import type { PeerSource, Stoppable } from "./peer-session";
import { startRosterSync } from "./roster-sync";

// The receive loop reaps revoked peers after every merge. Which roster it reaps against is the
// whole behaviour: the copy read before the merge is already out of date by the time the merge
// returns, because a merge of a large vault easily outlasts another device finishing enrolment.
// These drive the real loop through a supplied peerSource, so the ordering under test is the
// production one. See docs/p2p-sync-revocation-hardening.md.

// As in peer-source.test.ts: a supplied peerSource must never reach the network.
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

/** Two Channels wired to each other, counting each end's closes separately. */
function pipe(localPub: string, remotePub: string) {
	let localCloses = 0;
	let pushLocal: (d: string) => void = () => {};
	let pushRemote: (d: string) => void = () => {};
	const localEnd = makeChannel((d) => pushRemote(d));
	const remoteEnd = makeChannel((d) => pushLocal(d));
	pushLocal = localEnd.push;
	pushRemote = remoteEnd.push;
	return {
		local: {
			remotePubkey: remotePub,
			initiator: localPub < remotePub,
			channel: localEnd.channel,
			close: () => {
				localCloses++;
			},
		} satisfies PeerSession,
		remote: {
			remotePubkey: localPub,
			initiator: remotePub < localPub,
			channel: remoteEnd.channel,
			close: () => {},
		} satisfies PeerSession,
		/** Closes on the end held by the device under test — what reaping a peer does. */
		localClosed: () => localCloses,
	};
}

/** A source that hands peers over on demand, so a device can arrive mid-merge. */
function manualSource(): { source: PeerSource; hand: (peer: PeerSession) => void } {
	let deliver: ((peer: PeerSession) => void) | null = null;
	const queued: PeerSession[] = [];
	return {
		source: async ({ onPeer }) => {
			deliver = onPeer;
			for (const peer of queued) onPeer(peer);
			queued.length = 0;
			return { stop: () => {} } satisfies Stoppable;
		},
		hand: (peer) => {
			if (deliver) deliver(peer);
			else queued.push(peer);
		},
	};
}

/** Identity transport with a two-message handshake, so both roles complete against each other. */

const entriesOf = (marker: string) => JSON.stringify({ entries: [{ marker }], tombstones: [] });

const A = "aaaa";
const B = "bbbb";
const D = "dddd";

describe("the reap that follows a merge", () => {
	it("keeps a device that finished enrolling while the merge was still running", async () => {
		// A's roster as it sits on disk. It gains D partway through, which is what enrolling does.
		let onDisk = rosterOf([A, B]);
		const reports: string[] = [];
		let merging!: () => void;
		const mergeStarted = new Promise<void>((r) => {
			merging = r;
		});
		let release!: () => void;
		const held = new Promise<void>((r) => {
			release = r;
		});
		let mergeFinished = false;

		const srcA = manualSource();
		const a = await startRosterSync({
			relayUrl: "wss://relay.invalid",
			groupKeyB64: "unused",
			devicePrivB64: "privA",
			devicePubB64: A,
			roster: onDisk,
			wasm: identityWasm(),
			report: (s) => reports.push(s),
			fetchLocalPayload: async () => entriesOf("from-a"),
			fetchLocalRoster: async () => encodeRoster(onDisk),
			// Hold the merge open. Decrypting, merging and persisting a large vault is the window.
			pushRemotePayload: async () => {
				merging();
				await held;
				mergeFinished = true;
			},
			peerSource: srcA.source,
		});

		const linkB = pipe(A, B);
		const srcB = manualSource();
		srcB.hand(linkB.remote);
		const b = await startRosterSync({
			relayUrl: "wss://relay.invalid",
			groupKeyB64: "unused",
			devicePrivB64: "privB",
			devicePubB64: B,
			roster: rosterOf([A, B]),
			wasm: identityWasm(),
			report: () => {},
			fetchLocalPayload: async () => entriesOf("from-b"),
			pushRemotePayload: async () => {},
			peerSource: srcB.source,
		});
		srcA.hand(linkB.local);

		// B's payload reaches A and A is now inside the merge, holding the pre-merge roster.
		await mergeStarted;

		// D finishes enrolling: it is on disk, so A's roster-auth gate admits it.
		onDisk = rosterOf([A, B, D]);
		const linkD = pipe(A, D);
		const srcD = manualSource();
		srcD.hand(linkD.remote);
		const d = await startRosterSync({
			relayUrl: "wss://relay.invalid",
			groupKeyB64: "unused",
			devicePrivB64: "privD",
			devicePubB64: D,
			roster: onDisk,
			wasm: identityWasm(),
			report: () => {},
			fetchLocalPayload: async () => entriesOf("from-d"),
			pushRemotePayload: async () => {},
			peerSource: srcD.source,
		});
		srcA.hand(linkD.local);
		await vi.waitFor(() =>
			expect(reports.some((r) => r.startsWith(`synced with ${D.slice(0, 8)}`))).toBe(true),
		);

		// The merge returns. The reap that follows must read the roster again, not reuse the copy
		// from before the merge — that copy predates D and would disconnect it on its first sync.
		release();
		await vi.waitFor(() => expect(mergeFinished).toBe(true));
		await new Promise((r) => setTimeout(r, 50));

		expect(reports.filter((r) => r.includes("revoked"))).toEqual([]);
		expect(linkD.localClosed()).toBe(0);

		a.stop();
		b.stop();
		d.stop();
	});

	it("still drops a peer revoked while the merge was running", async () => {
		// The other half of the same fresh read: a revocation that lands during the merge has to
		// bite as soon as the merge returns, not at the next re-broadcast tick.
		let onDisk = rosterOf([A, B]);
		const reports: string[] = [];
		let merging!: () => void;
		const mergeStarted = new Promise<void>((r) => {
			merging = r;
		});
		let release!: () => void;
		const held = new Promise<void>((r) => {
			release = r;
		});
		let mergeFinished = false;

		const srcA = manualSource();
		const a = await startRosterSync({
			relayUrl: "wss://relay.invalid",
			groupKeyB64: "unused",
			devicePrivB64: "privA",
			devicePubB64: A,
			roster: onDisk,
			wasm: identityWasm(),
			report: (s) => reports.push(s),
			fetchLocalPayload: async () => entriesOf("from-a"),
			fetchLocalRoster: async () => encodeRoster(onDisk),
			pushRemotePayload: async () => {
				merging();
				await held;
				mergeFinished = true;
			},
			peerSource: srcA.source,
		});

		const linkB = pipe(A, B);
		const srcB = manualSource();
		srcB.hand(linkB.remote);
		const b = await startRosterSync({
			relayUrl: "wss://relay.invalid",
			groupKeyB64: "unused",
			devicePrivB64: "privB",
			devicePubB64: B,
			roster: rosterOf([A, B]),
			wasm: identityWasm(),
			report: () => {},
			fetchLocalPayload: async () => entriesOf("from-b"),
			pushRemotePayload: async () => {},
			peerSource: srcB.source,
		});
		srcA.hand(linkB.local);

		await mergeStarted;
		onDisk = rosterOf([A]); // B is revoked from another device while the merge runs
		release();
		await vi.waitFor(() => expect(mergeFinished).toBe(true));

		await vi.waitFor(() =>
			expect(reports.some((r) => r.includes(`${B.slice(0, 8)} revoked`))).toBe(true),
		);
		expect(linkB.localClosed()).toBeGreaterThan(0);

		a.stop();
		b.stop();
	});
});
