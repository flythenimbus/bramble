// The desktop app's local pipe as a path for attachment bytes. See docs/file-attachments.md.
//
// A browser extension and the desktop app on one machine are already joined by an authenticated
// link, which carries entry sync (link-peer-source on each side). Files ride it too, on streams of
// their own, because Firefox has no WebRTC in any extension context: there, the link is the only
// way a file reaches the browser. Nothing on it leaves the machine.
//
// Either end can restart, lock or reconnect while the other runs, so each conversation is a
// numbered stream, and the roles are fixed so the two ends never race to open one:
//   - the browser DIALS: it opens a stream, under a fresh random id, when it starts and whenever
//     the app pokes it.
//   - the app LISTENS: a frame on a stream it has not seen is a new peer, superseding that
//     browser's last. It pokes a browser it has no stream with: on start, when the browser says
//     it speaks files, and on a slow beat, so whichever end started first is not left waiting.
// Each end speaks only on its current stream and drops frames for any other, so a late frame from
// an old conversation is never read as the first of a new one.
//
// Above this, a link peer authenticates exactly as a mesh peer does (peer-auth.ts).

import { makeChannel } from "./channel";
import type { PeerSession } from "./mesh";
import type { PeerSource } from "./peer-session";

/** The browser's view of the link. */
export interface BlobLinkDialerTransport {
	/** Whether a link is up to an app that speaks files. */
	up(): Promise<boolean>;
	send(stream: number, frame: string): Promise<boolean>;
	/** Frames and pokes from the app. Returns an unsubscribe. */
	subscribe(handlers: { frame(stream: number, frame: string): void; poke(): void }): () => void;
}

/** One connection from a browser, as the app's link reports it. */
export interface LinkBrowser {
	peerId: string;
	/** Which connection: a reconnect is a new one, and supersedes. */
	link: number;
}

/** The app's view of the link. */
export interface BlobLinkListenerTransport {
	send(peerId: string, stream: number, frame: string): Promise<void>;
	poke(peerId: string): Promise<void>;
	/** Connected browsers that speak files. */
	peers(): Promise<LinkBrowser[]>;
	subscribe(handlers: {
		/** A browser said it speaks files. */
		capable(browser: LinkBrowser): void;
		gone(browser: LinkBrowser): void;
		frame(browser: LinkBrowser, stream: number, frame: string): void;
	}): Promise<() => void>;
}

/** How often the app pokes a browser it has no stream with. */
const POKE_MS = 60_000;
/** Superseded streams remembered per browser, so their late frames are dropped. */
const RETIRED_KEPT = 8;

/** A label, not a credential. The peer's real identity is learned over the channel. */
const APP_LABEL = "desktop";

const newStreamId = (): number => crypto.getRandomValues(new Uint32Array(1))[0] as number;

export function blobLinkDialer(transport: BlobLinkDialerTransport): PeerSource {
	return async ({ onPeer, report }) => {
		let live: { stream: number; push: (frame: string) => void } | null = null;
		let stopped = false;

		const open = () => {
			if (stopped) return;
			const stream = newStreamId();
			const { channel, push } = makeChannel((frame) => {
				// A superseded stream goes quiet rather than talking over its replacement.
				if (live?.stream === stream) void transport.send(stream, frame).catch(() => {});
			});
			live = { stream, push };
			report("desktop app offered as a file peer");
			onPeer({
				remotePubkey: APP_LABEL,
				initiator: true,
				channel,
				// Ends this stream only; the link itself carries entry sync and fill as well.
				close: () => {
					if (live?.stream === stream) live = null;
				},
			} satisfies PeerSession);
		};

		// Subscribed before asking whether the link is up, so a poke in between is not missed.
		const unsubscribe = transport.subscribe({
			frame: (stream, frame) => {
				if (live?.stream === stream) live.push(frame);
			},
			poke: open,
		});
		if (await transport.up()) open();

		return {
			stop() {
				stopped = true;
				live = null;
				unsubscribe();
			},
		};
	};
}

interface Served {
	link: number;
	stream: number | null;
	push: ((frame: string) => void) | null;
	retired: number[];
}

export function blobLinkListener(transport: BlobLinkListenerTransport): PeerSource {
	return async ({ onPeer, report }) => {
		const browsers = new Map<string, Served>();
		let stopped = false;

		const poke = (peerId: string) => void transport.poke(peerId).catch(() => {});

		/** The entry for this connection, or null for one a reconnect has since replaced. */
		const entryFor = (b: LinkBrowser): Served | null => {
			const current = browsers.get(b.peerId);
			if (current && current.link > b.link) return null;
			if (current && current.link === b.link) return current;
			const fresh: Served = { link: b.link, stream: null, push: null, retired: [] };
			browsers.set(b.peerId, fresh);
			return fresh;
		};

		const retire = (entry: Served) => {
			if (entry.stream === null) return;
			entry.retired.push(entry.stream);
			if (entry.retired.length > RETIRED_KEPT) entry.retired.shift();
			entry.stream = null;
			entry.push = null;
		};

		const serve = (b: LinkBrowser, entry: Served, stream: number) => {
			retire(entry);
			const isCurrent = () => browsers.get(b.peerId) === entry && entry.stream === stream;
			const { channel, push } = makeChannel((frame) => {
				if (isCurrent()) void transport.send(b.peerId, stream, frame).catch(() => {});
			});
			entry.stream = stream;
			entry.push = push;
			report(`browser ${b.peerId.slice(0, 8)} offered as a file peer`);
			onPeer({
				remotePubkey: b.peerId,
				initiator: false,
				channel,
				close: () => {
					if (isCurrent()) retire(entry);
				},
			} satisfies PeerSession);
		};

		const unsubscribe = await transport.subscribe({
			capable: (b) => {
				if (stopped) return;
				if (entryFor(b)) poke(b.peerId);
			},
			gone: (b) => {
				if (browsers.get(b.peerId)?.link === b.link) browsers.delete(b.peerId);
			},
			frame: (b, stream, frame) => {
				if (stopped) return;
				const entry = entryFor(b);
				if (!entry) return;
				if (entry.stream === stream) {
					entry.push?.(frame);
					return;
				}
				if (entry.retired.includes(stream)) return;
				serve(b, entry, stream);
				entry.push?.(frame);
			},
		});
		for (const b of await transport.peers()) {
			if (entryFor(b)) poke(b.peerId);
		}
		const beat = setInterval(() => {
			for (const [peerId, entry] of browsers) if (entry.stream === null) poke(peerId);
		}, POKE_MS);

		return {
			stop() {
				stopped = true;
				clearInterval(beat);
				browsers.clear();
				unsubscribe();
			},
		};
	};
}
