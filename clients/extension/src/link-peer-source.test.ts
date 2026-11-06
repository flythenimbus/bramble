import type { PeerSession } from "@core/sync/transport/mesh";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type LinkTransport, makeLinkPeerSource } from "./link-peer-source";

// The desktop app offered to sync as a local peer. What is under test is the bookkeeping either
// side of the pipe: when the app becomes a peer, when a refused one is offered again, and that
// dropping it never closes the link, which also carries autofill.

function transport(over: Partial<LinkTransport> = {}) {
	const sent: string[] = [];
	const sinks = new Set<(frame: string) => void>();
	const downSinks = new Set<() => void>();
	let unsubscribed = 0;
	return {
		sent,
		unsubscribed: () => unsubscribed,
		/** The background saying the link has gone. */
		down: () => {
			for (const sink of downSinks) sink();
		},
		/** The app speaking, as the background would relay it. */
		push: (frame: string) => {
			for (const sink of sinks) sink(frame);
		},
		transport: {
			send: async (frame: string) => {
				sent.push(frame);
				return true;
			},
			subscribe: (onFrame: (frame: string) => void) => {
				sinks.add(onFrame);
				return () => {
					unsubscribed++;
					sinks.delete(onFrame);
				};
			},
			subscribeDown: (onDown: () => void) => {
				downSinks.add(onDown);
				return () => downSinks.delete(onDown);
			},
			...over,
		} satisfies LinkTransport,
	};
}

async function start(t: LinkTransport, opts?: { eager?: boolean }) {
	const peers: PeerSession[] = [];
	const source = await makeLinkPeerSource(
		t,
		opts,
	)({
		onPeer: (p) => peers.push(p),
		report: () => {},
	});
	return { source, peers };
}

beforeEach(() => {
	vi.useRealTimers();
});

describe("the link going down", () => {
	it("tells the session its peer has gone, rather than leaving it to time out", async () => {
		// Until it times out, the session asks the background for the vault every 4 s, and each ask
		// keeps awake the worker that has to be replaced before the link can come back.
		const t = transport();
		const { peers } = await start(t.transport);
		t.push("hello");
		let gone = 0;
		peers[0]?.onGone?.(() => gone++);

		t.down();

		expect(gone).toBe(1);
	});

	it("takes the app straight back when it speaks again", async () => {
		// A link that went down is not a refusal, so no cool-down: a page lending a pipe brings it
		// back in a moment, and the user is looking at it.
		const t = transport();
		const { peers } = await start(t.transport);
		t.push("hello");
		peers[0]?.onGone?.(() => peers[0]?.close());

		t.down();
		t.push("hello again");

		expect(peers).toHaveLength(2);
	});

	it("does not let a superseded peer's close touch the one after it", async () => {
		const t = transport();
		const { peers } = await start(t.transport);
		t.push("hello");
		t.down();
		t.push("hello again");

		// The first peer's handshake times out late, after the second has been offered.
		peers[0]?.close();
		t.push("still here");

		expect(peers).toHaveLength(2);
	});
});

describe("the desktop app as a sync peer", () => {
	it("offers nothing until the app speaks", async () => {
		// This end cannot tell whether a desktop app is even paired, let alone running. Offering
		// regardless meant roster-auth talking into a pipe that was never opened and reporting a
		// handshake failure 15 seconds later, on every browser with no desktop app.
		const t = transport();
		const { peers } = await start(t.transport);
		expect(peers).toEqual([]);
	});

	it("offers it when the app speaks, which it does as soon as the pipe connects", async () => {
		const t = transport();
		const { peers } = await start(t.transport);

		t.push("hello");

		expect(peers).toHaveLength(1);
	});

	it("offers exactly one peer, however much the app says", async () => {
		const t = transport();
		const { peers } = await start(t.transport);

		t.push("f0");
		t.push("f1");
		t.push("f2");

		// A second live peer would mean two roster-auth handshakes racing on one pipe, each
		// reading the other's frames.
		expect(peers).toHaveLength(1);
	});

	it("delivers the app's frames to the peer, including the one that woke it", async () => {
		const t = transport();
		const { peers } = await start(t.transport);

		t.push("from-app");

		// The frame that caused the offer must not be swallowed by it: it is the peer's opening
		// message, and losing it would stall the handshake it belongs to.
		expect(await peers[0]?.channel.recv()).toBe("from-app");
	});

	it("sends the peer's frames to the app", async () => {
		const t = transport();
		const { peers } = await start(t.transport);
		t.push("wake");

		peers[0]?.channel.send("outbound");

		await vi.waitFor(() => expect(t.sent).toEqual(["outbound"]));
	});

	it("drops the peer when the app is not running, and offers again when it speaks", async () => {
		// A send failing means the app is not there. Nothing is wrong, so the peer goes and its
		// next broadcast brings a fresh one rather than talking into a closed pipe.
		const t = transport({ send: async () => false });
		const { peers } = await start(t.transport);
		t.push("wake");

		peers[0]?.channel.send("into-the-void");
		await vi.waitFor(() => {
			t.push("app-is-back");
			expect(peers).toHaveLength(2);
		});
	});
});

describe("declining the app", () => {
	it("does not close the link, which also carries autofill", async () => {
		const t = transport();
		const { peers } = await start(t.transport);
		t.push("wake");

		peers[0]?.close();

		// Nothing was sent and nothing unsubscribed: the pipe is untouched, so delegation keeps
		// working even when sync has decided it does not want this peer.
		expect(t.sent).toEqual([]);
		expect(t.unsubscribed()).toBe(0);
	});

	it("holds it off for a cool-down rather than re-handshaking on every frame", async () => {
		const t = transport();
		const { peers } = await start(t.transport);
		t.push("wake");
		peers[0]?.close();

		t.push("still-talking");
		t.push("still-talking");

		expect(peers).toHaveLength(1);
	});

	it("offers it again once the cool-down elapses", async () => {
		// Refusal is right at the time and wrong forever: an app enrolling a minute later would
		// never be offered again, so sync would only work after restarting the browser.
		vi.useFakeTimers();
		const t = transport();
		const { peers } = await start(t.transport);
		t.push("wake");
		peers[0]?.close();

		vi.setSystemTime(Date.now() + 31_000);
		t.push("retry");

		expect(peers).toHaveLength(2);
	});
});

describe("teardown", () => {
	it("unsubscribes and offers nothing more", async () => {
		const t = transport();
		const { source, peers } = await start(t.transport);
		t.push("wake");

		source.stop();
		t.push("after-stop");

		expect(t.unsubscribed()).toBe(1);
		expect(peers).toHaveLength(1);
	});
});

describe("the vault copy over the link", () => {
	it("offers the app at once, because this end opens the copy's handshake", async () => {
		// The joining browser is the Noise initiator and the app only answers. Waiting for the app
		// to speak first, as sync does, left both ends waiting until the invite expired.
		const t = transport();
		const { peers } = await start(t.transport, { eager: true });

		expect(peers).toHaveLength(1);
		peers[0]!.channel.send("msg1");
		await vi.waitFor(() => expect(t.sent).toEqual(["msg1"]));
	});
});
