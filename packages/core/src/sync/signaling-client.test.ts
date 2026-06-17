import { describe, expect, it } from "vitest";
import type { NostrEvent } from "./nostr";
import { connectSignaling, type SocketLike } from "./signaling-client";

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
