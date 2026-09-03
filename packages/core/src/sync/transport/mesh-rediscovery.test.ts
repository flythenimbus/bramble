import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSignalEvent, encryptSignal } from "..";
import { joinMesh } from "./mesh";

// `known` stops one hello from answering itself forever, and every close path clears it — except
// the ones that never opened anything. A peer whose setup throws, or one we are merely awaiting an
// offer from, is left marked as discovered with no transport behind it, so its every later hello is
// ignored as a duplicate and the two devices never connect again. Its own file because
// webrtcAvailable() caches per module, and this is the only test that wants WebRTC present.
// See Mesh.announce.

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

/** Enough RTCPeerConnection for webrtcAvailable()'s probe to pass. Creating the data channel is
 * where a real one fails when the context can't host WebRTC after all, which is the case under
 * test: discover() catches that, having already marked the peer known. */
class FakePeerConnection {
	createDataChannel(): never {
		throw new Error("no data channel here");
	}
	close(): void {}
}

const realSetTimeout = globalThis.setTimeout;
const settle = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await new Promise((r) => realSetTimeout(r, 0));
};

async function tick(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await settle();
}

const status: string[] = [];
const setupFailures = () => status.filter((m) => m.startsWith("peer setup failed")).length;
const started: { stop: () => void }[] = [];

async function mesh() {
	const m = await joinMesh({
		relayUrl: "wss://relay.invalid",
		groupKey: GROUP_KEY,
		roomLabel: "bramble/sync",
		// Lower than REMOTE, so this side is the one that offers — and so the one whose setup runs.
		signer: {
			pubkeyHex: "ab".repeat(32),
			signer: { pubkeyHex: "ab".repeat(32), sign: async () => "cd".repeat(32) },
			verifier: { verify: async () => true },
		},
		onStatus: (m: string) => status.push(m),
		onPeer: () => {},
	});
	started.push(m);
	return m;
}

async function deliverHello(socket: FakeSocket): Promise<void> {
	const content = await encryptSignal(GROUP_KEY, JSON.stringify({ kind: "hello", rtc: true }));
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
	status.length = 0;
	vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
	vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);
	vi.useFakeTimers();
});

afterEach(async () => {
	for (const m of started.splice(0)) m.stop();
	await tick(0);
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("a peer marked known with nothing behind it", () => {
	it("is retried after an announce tick rather than ignored forever", async () => {
		await mesh();
		sockets[0]?.open();
		await tick(0);

		await deliverHello(sockets[0]!);
		expect(setupFailures()).toBe(1);

		// Every later hello is a duplicate discovery, so nothing is attempted.
		await deliverHello(sockets[0]!);
		expect(setupFailures()).toBe(1);

		await tick(31_000);
		await deliverHello(sockets[0]!);

		expect(setupFailures()).toBe(2);
	});
});
