import type { PeerSession } from "@core/sync/transport/mesh";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The source that offers browsers on this machine to sync over the native link. What is under
// test is the bookkeeping around the pipe, not the pipe: which browsers become peers, when a
// declined one is offered again, and that dropping a sync peer never costs the user autofill.

const h = vi.hoisted(() => ({
	/** Tauri event listeners, by event name. */
	listeners: new Map<string, (e: { payload: unknown }) => void>(),
	unlistened: 0,
	/** Browsers the Rust side reports as connected. */
	connected: [] as { peerId: string; link: number }[],
	/** Frames handed to the Rust side for delivery, and whether that delivery fails. */
	sent: [] as { peerId: string; frame: string }[],
	sendFails: false,
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: async (cmd: string, args?: Record<string, unknown>) => {
		if (cmd === "link_sync_peers") return h.connected;
		if (cmd === "link_sync_send") {
			if (h.sendFails) throw new Error("no such peer");
			h.sent.push(args as unknown as { peerId: string; frame: string });
			return undefined;
		}
		throw new Error(`unexpected command ${cmd}`);
	},
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
		h.listeners.set(name, cb);
		return () => {
			h.unlistened++;
		};
	},
}));

const fire = (name: string, payload: unknown) => {
	const cb = h.listeners.get(name);
	if (!cb) throw new Error(`nothing listening for ${name}`);
	cb({ payload });
};

async function start() {
	vi.resetModules();
	const { linkPeerSource } = await import("./link-peers");
	const peers: PeerSession[] = [];
	const source = await linkPeerSource({
		onPeer: (p) => peers.push(p),
		report: () => {},
	});
	return { source, peers };
}

beforeEach(() => {
	h.listeners.clear();
	h.unlistened = 0;
	h.connected = [];
	h.sent.length = 0;
	h.sendFails = false;
	vi.useRealTimers();
});

describe("browsers offered as sync peers", () => {
	it("offers browsers that were already connected when sync started", async () => {
		// Sync starts on unlock, long after a browser connected at its own startup, so waiting for
		// a connect event would mean no sync until the browser restarted.
		h.connected = [
			{ peerId: "browser-a", link: 1 },
			{ peerId: "browser-b", link: 1 },
		];

		const { peers } = await start();

		expect(peers.map((p) => p.remotePubkey)).toEqual(["browser-a", "browser-b"]);
	});

	it("offers a browser that connects later", async () => {
		const { peers } = await start();
		fire("link-peer-connected", { peerId: "browser-a", link: 1 });
		expect(peers.map((p) => p.remotePubkey)).toEqual(["browser-a"]);
	});

	it("offers each browser once, not once per event", async () => {
		h.connected = [{ peerId: "browser-a", link: 1 }];
		const { peers } = await start();

		fire("link-peer-connected", { peerId: "browser-a", link: 1 });
		fire("link-sync-frame", { peerId: "browser-a", link: 1, frame: "f1" });

		// A second live peer for one browser would mean two roster-auth handshakes racing on one
		// pipe, and each one's frames read as the other's.
		expect(peers).toHaveLength(1);
	});

	it("routes frames to the peer they belong to", async () => {
		h.connected = [
			{ peerId: "browser-a", link: 1 },
			{ peerId: "browser-b", link: 1 },
		];
		const { peers } = await start();
		const a = peers[0]?.channel.recv();
		const b = peers[1]?.channel.recv();

		fire("link-sync-frame", { peerId: "browser-b", link: 1, frame: "for-b" });
		fire("link-sync-frame", { peerId: "browser-a", link: 1, frame: "for-a" });

		expect(await a).toBe("for-a");
		expect(await b).toBe("for-b");
	});

	it("sends a peer's frames to that browser", async () => {
		h.connected = [{ peerId: "browser-a", link: 1 }];
		const { peers } = await start();

		peers[0]?.channel.send("outbound");

		await vi.waitFor(() => expect(h.sent).toHaveLength(1));
		expect(h.sent[0]).toEqual({ peerId: "browser-a", frame: "outbound" });
	});
});

describe("closing a peer", () => {
	it("does not close the link, because the same connection serves autofill", async () => {
		h.connected = [{ peerId: "browser-a", link: 1 }];
		const { peers } = await start();

		peers[0]?.close();

		// Nothing was asked of the Rust side: the browser stays connected and keeps answering
		// fills. Dropping a sync peer is a local decision about sync alone.
		expect(h.sent).toEqual([]);
	});

	it("stops routing frames to a closed peer", async () => {
		h.connected = [{ peerId: "browser-a", link: 1 }];
		const { peers } = await start();
		peers[0]?.close();

		fire("link-sync-frame", { peerId: "browser-a", link: 1, frame: "after-close" });

		// Re-offered rather than delivered to the dead peer: the cool-down has not elapsed, so it
		// is not offered again either.
		expect(peers).toHaveLength(1);
	});

	it("offers a declined browser again after the cool-down", async () => {
		// A browser is closed when it fails roster-auth, which is right the first time and wrong
		// forever: the same browser enrolling a minute later would never be offered again.
		vi.useFakeTimers();
		h.connected = [{ peerId: "browser-a", link: 1 }];
		const { peers } = await start();
		peers[0]?.close();

		vi.setSystemTime(Date.now() + 31_000);
		fire("link-sync-frame", { peerId: "browser-a", link: 1, frame: "retry" });

		expect(peers).toHaveLength(2);
		expect(peers[1]?.remotePubkey).toBe("browser-a");
	});

	it("offers a declined browser again as soon as it reconnects", async () => {
		// A reconnect is a fresh start, so it should not have to wait out a cool-down that exists
		// for peers which are still connected and re-broadcasting.
		h.connected = [{ peerId: "browser-a", link: 1 }];
		const { peers } = await start();
		peers[0]?.close();

		fire("link-peer-disconnected", { peerId: "browser-a", link: 1 });
		fire("link-peer-connected", { peerId: "browser-a", link: 1 });

		expect(peers).toHaveLength(2);
	});

	it("forgets a peer whose browser went away mid-send", async () => {
		h.connected = [{ peerId: "browser-a", link: 1 }];
		const { peers } = await start();
		h.sendFails = true;

		peers[0]?.channel.send("outbound");

		// The failed send drops it, so its next broadcast re-offers rather than pushing into a
		// queue nobody drains.
		await vi.waitFor(() => {
			fire("link-sync-frame", { peerId: "browser-a", link: 1, frame: "retry" });
			expect(peers).toHaveLength(2);
		});
	});
});

describe("teardown", () => {
	it("unsubscribes every listener and offers nothing more", async () => {
		h.connected = [{ peerId: "browser-a", link: 1 }];
		const { source, peers } = await start();

		source.stop();
		fire("link-peer-connected", { peerId: "browser-b", link: 1 });

		expect(h.unlistened).toBe(3);
		expect(peers).toHaveLength(1);
	});
});
