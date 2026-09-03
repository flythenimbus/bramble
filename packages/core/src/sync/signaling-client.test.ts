import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NostrEvent } from "./nostr";
import { connectSignaling, RELAY_PING, RELAY_PONG, type SocketLike } from "./signaling-client";

function fakeSocket() {
	const sent: string[] = [];
	let closed = false;
	const sock: SocketLike = {
		send: (d) => sent.push(d),
		close: () => {
			closed = true;
		},
		onopen: null,
		onmessage: null,
		onclose: null,
		onerror: null,
	};
	return {
		sock,
		sent,
		isClosed: () => closed,
		open: () => sock.onopen?.(),
		deliver: (data: unknown) => sock.onmessage?.({ data: JSON.stringify(data) }),
		deliverRaw: (data: string) => sock.onmessage?.({ data }),
		pings: () => sent.filter((f) => f === RELAY_PING).length,
	};
}

const event = (id: string): NostrEvent => ({
	id,
	pubkey: "pk",
	created_at: 1,
	kind: 20000,
	tags: [["d", "room"]],
	content: "ct",
	sig: "sig",
});

describe("connectSignaling", () => {
	it("sends the room REQ on open", () => {
		const f = fakeSocket();
		connectSignaling(f.sock, "room", () => {});
		f.open();
		const req = JSON.parse(f.sent[0]!);
		expect(req[0]).toBe("REQ");
		expect(req[2]).toEqual({ kinds: [20000], "#d": ["room"] });
	});

	it("buffers publishes made before open, then flushes after the REQ", () => {
		const f = fakeSocket();
		const client = connectSignaling(f.sock, "room", () => {});
		client.publish(event("a")); // before open
		expect(f.sent).toHaveLength(0);
		f.open();
		// First frame is the REQ, then the buffered EVENT.
		expect(JSON.parse(f.sent[0]!)[0]).toBe("REQ");
		expect(JSON.parse(f.sent[1]!)).toEqual(["EVENT", event("a")]);
	});

	it("dispatches incoming events for our subscription", () => {
		const f = fakeSocket();
		const got: NostrEvent[] = [];
		connectSignaling(f.sock, "room", (e) => got.push(e));
		f.open();
		const subId = JSON.parse(f.sent[0]!)[1];
		f.deliver(["EVENT", subId, event("x")]);
		expect(got).toEqual([event("x")]);
	});

	it("ignores events for a different subscription and malformed frames", () => {
		const f = fakeSocket();
		const got: NostrEvent[] = [];
		connectSignaling(f.sock, "room", (e) => got.push(e));
		f.open();
		f.deliver(["EVENT", "someoneElse", event("y")]);
		f.deliver(["EOSE", "sub"]);
		f.sock.onmessage?.({ data: "not json" });
		expect(got).toEqual([]);
	});

	it("sends CLOSE and closes the socket", () => {
		const f = fakeSocket();
		const client = connectSignaling(f.sock, "room", () => {});
		f.open();
		client.close();
		expect(JSON.parse(f.sent.at(-1)!)[0]).toBe("CLOSE");
		expect(f.isClosed()).toBe(true);
	});
});

// Cloudflare drops an idle WebSocket after a minute or two, which for a password manager syncing
// in the background is most of the time. Each drop rebuilt the socket, and on Chrome woke the
// suspended service worker, which restarted the whole sync session. See PING_MS in the module.
describe("the relay keepalive", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("pings an idle socket", async () => {
		const f = fakeSocket();
		connectSignaling(f.sock, "room", () => {});
		f.open();
		expect(f.pings()).toBe(0);

		await vi.advanceTimersByTimeAsync(26_000);

		expect(f.pings()).toBe(1);
	});

	it("does not ping before the socket opens", async () => {
		const f = fakeSocket();
		connectSignaling(f.sock, "room", () => {});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.pings()).toBe(0);
	});

	it("closes a socket the relay has stopped answering, so the caller reconnects", async () => {
		const f = fakeSocket();
		connectSignaling(f.sock, "room", () => {});
		f.open();
		await vi.advanceTimersByTimeAsync(26_000);
		f.deliverRaw(RELAY_PONG); // this relay speaks the keepalive, so its silence means something

		await vi.advanceTimersByTimeAsync(100_000);

		expect(f.isClosed()).toBe(true);
	});

	it("keeps pinging a relay that never answers rather than declaring it dead", async () => {
		// A stock Nostr relay ignores an unrecognised frame. Silence from one proves nothing, and
		// closing on it would put the client in a reconnect loop against a perfectly good relay.
		const f = fakeSocket();
		connectSignaling(f.sock, "room", () => {});
		f.open();

		await vi.advanceTimersByTimeAsync(200_000);

		expect(f.isClosed()).toBe(false);
		expect(f.pings()).toBeGreaterThan(1);
	});

	it("treats any traffic as proof of life", async () => {
		const f = fakeSocket();
		connectSignaling(f.sock, "room", () => {});
		f.open();
		await vi.advanceTimersByTimeAsync(26_000);
		f.deliverRaw(RELAY_PONG);

		// A busy room: events keep arriving even though no pong does.
		for (let i = 0; i < 8; i++) {
			await vi.advanceTimersByTimeAsync(20_000);
			f.deliver(["EOSE", "sub"]);
		}

		expect(f.isClosed()).toBe(false);
	});

	it("does not dispatch a pong as an event", async () => {
		const f = fakeSocket();
		const got: NostrEvent[] = [];
		connectSignaling(f.sock, "room", (e) => got.push(e));
		f.open();
		f.deliverRaw(RELAY_PONG);
		expect(got).toEqual([]);
	});

	it("stops pinging once the socket goes away, and leaves the caller's onclose intact", async () => {
		const f = fakeSocket();
		let sawClose = false;
		f.sock.onclose = () => {
			sawClose = true;
		};
		connectSignaling(f.sock, "room", () => {});
		f.open();

		f.sock.onclose?.({});
		await vi.advanceTimersByTimeAsync(120_000);

		expect(sawClose).toBe(true);
		expect(f.pings()).toBe(0);
	});

	it("stops pinging after close()", async () => {
		const f = fakeSocket();
		const client = connectSignaling(f.sock, "room", () => {});
		f.open();
		client.close();

		await vi.advanceTimersByTimeAsync(120_000);

		expect(f.pings()).toBe(0);
	});
});
