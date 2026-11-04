import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSignalEvent, encryptSignal } from "..";
import { joinMesh, type PeerSession } from "./mesh";

// A peer the sync layer skips because it is on the local link (the desktop app and its browser)
// must stay skipped. Closing it like any other peer cleared `known`, so its next hello set the
// connection up again, through the relay, every few seconds for as long as both ran.

const GROUP_KEY = new Uint8Array(32).fill(7);
const REMOTE = "ff".repeat(32);

const sockets: FakeSocket[] = [];

class FakeSocket {
	onopen: (() => void) | null = null;
	onclose: ((ev: unknown) => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	readyState = 0;
	sent: string[] = [];

	constructor(public url: string) {
		sockets.push(this);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.readyState = 3;
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
	subId(): string {
		for (const frame of this.sent) {
			try {
				const m: unknown = JSON.parse(frame);
				if (Array.isArray(m) && m[0] === "REQ") return m[1] as string;
			} catch {
				// a keepalive ping, which isn't JSON
			}
		}
		return "";
	}
}

const realSetTimeout = globalThis.setTimeout;
const hop = () => new Promise((r) => realSetTimeout(r, 0));
const settle = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await hop();
};
const settleUntil = async (ok: () => boolean): Promise<void> => {
	for (let i = 0; i < 500 && !ok(); i++) await hop();
};

async function tick(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await settle();
}

const peers: PeerSession[] = [];
const started: { stop: () => void }[] = [];

async function mesh() {
	const m = await joinMesh({
		relayUrl: "wss://relay.invalid",
		groupKey: GROUP_KEY,
		roomLabel: "bramble/sync",
		signer: {
			pubkeyHex: "ab".repeat(32),
			signer: { pubkeyHex: "ab".repeat(32), sign: async () => "cd".repeat(32) },
			verifier: { verify: async () => true },
		},
		onStatus: () => {},
		onPeer: (p) => peers.push(p),
	});
	started.push(m);
	return m;
}

/** The remote's hello, with no WebRTC, so the mesh opens a relay channel at once. */
async function deliverHello(socket: FakeSocket): Promise<void> {
	const content = await encryptSignal(GROUP_KEY, JSON.stringify({ kind: "hello", rtc: false }));
	const event = await buildSignalEvent(
		{ pubkeyHex: REMOTE, sign: async () => "ee".repeat(32) },
		"room",
		content,
		Math.floor(Date.now() / 1000),
	);
	socket.onmessage?.({ data: JSON.stringify(["EVENT", socket.subId(), event]) });
	await settle();
}

beforeEach(() => {
	sockets.length = 0;
	peers.length = 0;
	vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
	vi.useFakeTimers();
});

afterEach(async () => {
	for (const m of started.splice(0)) m.stop();
	await tick(0);
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("a peer skipped for the local link", () => {
	it("is not connected again on its next hello, even after an announce tick", async () => {
		await mesh();
		sockets[0]?.open();
		await tick(0);

		await deliverHello(sockets[0]!);
		await settleUntil(() => peers.length === 1);
		expect(peers).toHaveLength(1);
		// As peer-auth does: skip where the session can, close where it cannot.
		const peer = peers[0]!;
		if (peer.skip) peer.skip();
		else peer.close();

		await deliverHello(sockets[0]!);
		await tick(31_000);
		await deliverHello(sockets[0]!);

		expect(peers).toHaveLength(1);
	});

	it("is connected again after an ordinary close, as before", async () => {
		await mesh();
		sockets[0]?.open();
		await tick(0);

		await deliverHello(sockets[0]!);
		await settleUntil(() => peers.length === 1);
		peers[0]!.close();

		await tick(31_000);
		await deliverHello(sockets[0]!);
		await settleUntil(() => peers.length === 2);

		expect(peers).toHaveLength(2);
	});
});
