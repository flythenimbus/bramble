import { describe, expect, it, vi } from "vitest";
import { memoryBlobStore, sameBytes, sha256Hex } from "../../test/memory-blob-store";
import { testBlobSession } from "../../test/transport-fakes";
import {
	type BlobLinkDialerTransport,
	type BlobLinkListenerTransport,
	blobLinkDialer,
	blobLinkListener,
	type LinkBrowser,
} from "./blob-link";
import { WINDOW } from "./blob-sync";

// Files between a browser and the desktop app over their local link. The link is simulated
// here (it is a native pipe in life, relayed by the background and the app's socket), but the
// two ends are the shipped dialer and listener, and above them run real blob sessions. What has
// to hold is that either end can start first, and that a reconnect cannot cross two streams.

/** One browser's link to the app, frames delivered in order, as the pipe does. */
function simulatedLink() {
	const peerId = "browser-key";
	let gen = 1;
	let toBrowser: Parameters<BlobLinkDialerTransport["subscribe"]>[0] | null = null;
	let toApp: Parameters<BlobLinkListenerTransport["subscribe"]>[0] | null = null;
	const browser = (): LinkBrowser => ({ peerId, link: gen });
	const sentByBrowser: { stream: number; frame: string }[] = [];

	const dialer: BlobLinkDialerTransport = {
		up: async () => true,
		send: async (stream, frame) => {
			sentByBrowser.push({ stream, frame });
			const from = browser();
			queueMicrotask(() => toApp?.frame(from, stream, frame));
			return true;
		},
		subscribe: (handlers) => {
			toBrowser = handlers;
			return () => {
				toBrowser = null;
			};
		},
	};
	const listener: BlobLinkListenerTransport = {
		send: async (_peerId, stream, frame) => {
			queueMicrotask(() => toBrowser?.frame(stream, frame));
		},
		poke: async () => {
			queueMicrotask(() => toBrowser?.poke());
		},
		peers: async () => [browser()],
		subscribe: async (handlers) => {
			toApp = handlers;
			return () => {
				toApp = null;
			};
		},
	};
	return {
		dialer,
		listener,
		sentByBrowser,
		/** The browser reconnects: the app sees the old connection go and a new one declare. */
		reconnect() {
			toApp?.gone(browser());
			gen++;
			toApp?.capable(browser());
		},
		/** A frame the app sends as if from the browser's connection, on any stream. */
		injectFromBrowser(stream: number, frame: string) {
			toApp?.frame(browser(), stream, frame);
		},
	};
}

async function file(len: number, seed: number) {
	const body = Uint8Array.from({ length: len }, (_, i) => (i * seed + (i >> 9)) % 251);
	return { body, hash: await sha256Hex(body), size: len };
}

describe("files over the desktop link", () => {
	it("reach the browser when the browser was running first", async () => {
		const f = await file(2 * WINDOW + 99, 3);
		const app = memoryBlobStore().store;
		await app.put(f.hash, f.body);
		const browser = memoryBlobStore().store;
		const link = simulatedLink();

		// The browser dials into an app whose file session has not started: nobody answers.
		const b = await testBlobSession("bbbb", blobLinkDialer(link.dialer), browser, [f]);
		await new Promise((r) => setTimeout(r, 50));
		// The app starts, pokes, and the browser dials again.
		const a = await testBlobSession("aaaa", blobLinkListener(link.listener), app, [f]);
		await vi.waitFor(async () => expect(await browser.has(f.hash)).toBe(true), {
			timeout: 10_000,
		});
		expect(sameBytes(await browser.read(f.hash), f.body)).toBe(true);
		a.stop();
		b.stop();
	});

	it("reach the app when the app was running first", async () => {
		const f = await file(5000, 7);
		const browser = memoryBlobStore().store;
		await browser.put(f.hash, f.body);
		const app = memoryBlobStore().store;
		const link = simulatedLink();
		const a = await testBlobSession("aaaa", blobLinkListener(link.listener), app, [f]);
		const b = await testBlobSession("bbbb", blobLinkDialer(link.dialer), browser, [f]);
		await vi.waitFor(async () => expect(await app.has(f.hash)).toBe(true), { timeout: 10_000 });
		a.stop();
		b.stop();
	});

	it("carry on after the browser reconnects, on the new stream only", async () => {
		const first = await file(3000, 11);
		const second = await file(4000, 13);
		const app = memoryBlobStore().store;
		await app.put(first.hash, first.body);
		const browser = memoryBlobStore().store;
		const link = simulatedLink();
		const wanted = [first, second];
		const a = await testBlobSession("aaaa", blobLinkListener(link.listener), app, wanted);
		const b = await testBlobSession("bbbb", blobLinkDialer(link.dialer), browser, wanted);
		await vi.waitFor(async () => expect(await browser.has(first.hash)).toBe(true), {
			timeout: 10_000,
		});

		const streamsBefore = new Set(link.sentByBrowser.map((s) => s.stream));
		link.reconnect();
		await app.put(second.hash, second.body);
		a.poke();
		await vi.waitFor(async () => expect(await browser.has(second.hash)).toBe(true), {
			timeout: 10_000,
		});
		// The second file came over a stream the browser opened after the reconnect.
		const after = link.sentByBrowser.slice(-1)[0]?.stream as number;
		expect(streamsBefore.has(after)).toBe(false);
		a.stop();
		b.stop();
	});

	it("never read a late frame from a superseded stream as a new peer", async () => {
		const offered: string[] = [];
		const link = simulatedLink();
		const source = blobLinkListener(link.listener);
		const stop = await source({
			onPeer: (peer) => offered.push(peer.remotePubkey),
			report: () => {},
		});
		link.injectFromBrowser(1, "pub");
		link.injectFromBrowser(2, "pub"); // supersedes stream 1
		link.injectFromBrowser(1, "late"); // a frame of stream 1 still in the pipe
		expect(offered).toEqual(["browser-key", "browser-key"]);
		stop.stop();
	});

	it("drop frames for any stream but the browser's current one", async () => {
		const link = simulatedLink();
		const received: string[] = [];
		const stop = await blobLinkDialer(link.dialer)({
			onPeer: (peer) => {
				peer.channel.send("hello");
				void (async () => {
					for (;;) received.push(await peer.channel.recv());
				})();
			},
			report: () => {},
		});
		await vi.waitFor(() => expect(link.sentByBrowser).toHaveLength(1));
		const stream = link.sentByBrowser[0]?.stream as number;
		await link.listener.send("browser-key", stream + 1, "stale");
		await link.listener.send("browser-key", stream, "current");
		await vi.waitFor(() => expect(received).toEqual(["current"]));
		stop.stop();
	});
});
