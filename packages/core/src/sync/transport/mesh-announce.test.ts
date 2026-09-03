import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSignalEvent, encryptSignal } from "..";
import { joinMesh, type PeerSession } from "./mesh";

// The relay stores nothing, so a hello published while the other side's socket was down is simply
// gone. `known` (which keeps one hello from answering itself forever) then also suppresses the
// rediscovery of that peer, and relay-forward has no close event to clear it — so two devices sit
// in the same room indefinitely, each believing it already found the other. Socket drops used to
// hide this by producing a fresh hello every minute or two; the relay keepalive removed that
// accident, which is what makes the periodic re-announce load-bearing. See Mesh.announce.

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
	/** The subscription the mesh asked for, which incoming events must be addressed to. */
	subId(): string {
		const req = this.sent.map(parse).find((m) => m?.[0] === "REQ");
		return req?.[1] as string;
	}
	events(): unknown[] {
		return this.sent.map(parse).filter((m) => m?.[0] === "EVENT");
	}
}

function parse(frame: string): unknown[] | null {
	try {
		const m: unknown = JSON.parse(frame);
		return Array.isArray(m) ? m : null;
	} catch {
		return null; // a keepalive ping, which isn't JSON
	}
}

// Captured before the timers are faked: publishing a hello runs real WebCrypto, whose promises
// settle on the event loop rather than the microtask queue, so draining them needs a real turn.
const realSetTimeout = globalThis.setTimeout;
const settle = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await new Promise((r) => realSetTimeout(r, 0));
};

/** Let timers fire and the mesh's async publish/handle chains settle. */
async function tick(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await settle();
}

const started: { stop: () => void }[] = [];

async function mesh(onPeer: (p: PeerSession) => void = () => {}) {
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
		onPeer,
	});
	started.push(m);
	return m;
}

/** Deliver a hello from REMOTE, encrypted under the group key as a real peer's would be. */
async function deliverHello(socket: FakeSocket): Promise<void> {
	const content = await encryptSignal(GROUP_KEY, JSON.stringify({ kind: "hello", rtc: false }));
	// Built rather than hand-rolled: verifyEvent recomputes the id from the contents.
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
	vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
	vi.useFakeTimers();
});

afterEach(async () => {
	for (const m of started.splice(0)) m.stop();
	await tick(0);
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("peer announcements", () => {
	it("re-announces while the session is up", async () => {
		await mesh();
		sockets[0]?.open();
		await tick(0);
		const first = sockets[0]?.events().length ?? 0;
		expect(first).toBeGreaterThan(0); // the hello at startup

		await tick(31_000);

		expect(sockets[0]?.events().length).toBeGreaterThan(first);
	});

	it("stops announcing once the session is stopped", async () => {
		const m = await mesh();
		sockets[0]?.open();
		await tick(0);
		m.stop();
		const atStop = sockets[0]?.events().length ?? 0;

		await tick(120_000);

		expect(sockets[0]?.events().length).toBe(atStop);
	});

	it("connects a peer once, however many times it says hello", async () => {
		const peers: PeerSession[] = [];
		await mesh((p) => peers.push(p));
		sockets[0]?.open();
		await tick(0);

		await deliverHello(sockets[0]!);
		await deliverHello(sockets[0]!);

		expect(peers).toHaveLength(1);
	});

	it("keeps a live peer across announce ticks", async () => {
		const peers: PeerSession[] = [];
		await mesh((p) => peers.push(p));
		sockets[0]?.open();
		await tick(0);
		await deliverHello(sockets[0]!);

		await tick(120_000);
		await deliverHello(sockets[0]!);

		expect(peers).toHaveLength(1);
	});
});
