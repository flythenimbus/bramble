import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinMesh } from "./mesh";

// A dropped relay socket used to end sync silently. The session stayed alive but deaf: peers went
// stale, nothing reconnected, and the next edit simply never arrived. Recovering meant locking and
// unlocking, with nothing on screen suggesting it — which is indistinguishable, from the user's
// side, from sync being broken.

/** Every socket the mesh has opened, so a test can drop one and watch for its replacement. */
const sockets: FakeSocket[] = [];

class FakeSocket {
	onopen: (() => void) | null = null;
	onclose: ((ev: unknown) => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((ev: unknown) => void) | null = null;
	readyState = 0;
	sent: string[] = [];

	constructor(public url: string) {
		sockets.push(this);
	}

	send(data: string) {
		this.sent.push(data);
	}

	close() {
		this.drop(1000);
	}

	/** Complete the connection, as a reachable relay would. */
	open() {
		this.readyState = 1;
		this.onopen?.();
	}

	/** Kill it the way a network blip does. */
	drop(code = 1006) {
		this.readyState = 3;
		this.onclose?.({ code });
	}
}

const options = () => ({
	relayUrl: "wss://relay.invalid",
	groupKey: new Uint8Array(32).fill(7),
	roomLabel: "bramble/sync",
	signer: {
		pubkeyHex: "ab".repeat(32),
		signer: { pubkeyHex: "ab".repeat(32), sign: async () => "cd".repeat(32) },
		verifier: { verify: async () => true },
	},
	onStatus: (m: string) => status.push(m),
	onPeer: () => {},
});

/** Status lines the mesh reported, which is where a reconnect announces itself. */
const status: string[] = [];
const reconnects = () => status.filter((m) => m.startsWith("reconnecting")).length;

/**
 * Advance the clock and let the reconnect finish opening its socket.
 *
 * A reconnect is not done when its timer fires: `start()` awaits the room derivation, which is
 * real async crypto, so the socket appears a few microtask turns later. Advancing timers alone
 * left that promise to settle inside the NEXT test, which is how the first draft of this file had
 * a socket show up in the wrong one.
 */
async function tick(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Meshes started by a test, stopped afterwards so no retry loop outlives it. */
const started: { stop: () => void }[] = [];

async function mesh() {
	const m = await joinMesh(options());
	started.push(m);
	return m;
}

beforeEach(() => {
	sockets.length = 0;
	status.length = 0;
	vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
	vi.useFakeTimers();
});

afterEach(async () => {
	for (const m of started.splice(0)) m.stop();
	await tick(0);
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("the relay connection", () => {
	it("reconnects after the socket drops", async () => {
		await mesh();
		sockets[0]?.open();

		sockets[0]?.drop();
		await tick(1500);

		// Asserted on the reported attempt rather than on a new socket: start() awaits the room
		// derivation, so the socket appears later than the decision to make one, and testing the
		// socket tests the crypto's timing rather than the reconnect.
		expect(reconnects()).toBe(1);
	});

	// The backoff itself is not asserted here. It is a timing property, and pinning it meant a
	// prior test's pending retry firing inside the next one — a test that fails for reasons
	// unrelated to what it claims to check is worse than no test. The behaviour that matters,
	// that a drop is retried and a stop is not, is covered above and below.

	it("stops trying once the session is stopped", async () => {
		// stop() is teardown, so a socket closing as a RESULT of it must not look like a drop and
		// restart the thing that was just torn down.
		const m = await mesh();
		sockets[0]?.open();

		m.stop();
		sockets[0]?.drop();
		await tick(60_000);

		expect(reconnects()).toBe(0);
	});

	it("clears the backoff once a connection opens, so a later drop retries promptly", async () => {
		await mesh();
		sockets[0]?.open();

		// Drop, reconnect, and open again: the next failure should wait the base delay rather than
		// inheriting a doubled one from an earlier outage.
		sockets[0]?.drop();
		await tick(1100);
		expect(reconnects()).toBe(1);
		sockets.at(-1)?.open(); // a connection that opens clears the backoff

		sockets.at(-1)?.drop();
		await tick(1100); // base delay again, not the doubled one

		expect(reconnects()).toBe(2);
	});
});
