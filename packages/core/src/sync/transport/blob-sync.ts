// Moving attachment bytes between a vault's devices. See docs/file-attachments.md (Transfer).
//
// A second session beside entry sync, never a part of it: its own room ("bramble/blob"), its own
// connections, and WebRTC only. A file's bytes travel over a peer connection, direct or relayed by
// TURN (end-to-end encrypted either way), or over the desktop app's local pipe (a PeerSource), and
// never through the signalling relay: the mesh refuses relay-forward. A pair without WebRTC
// (Firefox, beside no desktop app) simply does not exchange files, and says so.
//
// Peers authenticate exactly as entry sync's do (peer-auth.ts), then speak a pull protocol over
// the Noise session:
//   have {h}        every blob this device holds, on connect, on change, and as a heartbeat
//   want {h, o, n}  send me `n` bytes of `h` from offset `o`
//   data {h, o, d}  a slice of a wanted window, base64
//   nope {h}        I do not hold `h`
// Bytes are pulled, never pushed, in windows, into the blob store's staging. Nothing becomes a
// blob until the whole file hashes to its own name, so a lying or broken peer can cost a
// retry but never deliver a wrong file. A transfer cut off keeps its staged prefix and resumes.

import { base64ToBytes, bytesToBase64 } from "../../util/bytes";
import type { BlobReceipt, BlobStore } from "../../vault/blob-store";
import type { EntriesPayload, RosterPayload } from "..";
import { liveFiles } from "../vault-merge";
import type { Channel } from "./channel";
import type { PeerSession } from "./mesh";
import type { NostrWasm } from "./nostr-signer";
import { authenticatePeer, currentRoster, inRoster, type RosterHandshakeWasm } from "./peer-auth";
import { type MeshSession, type PeerSource, startMeshSession } from "./peer-session";
import { recvSecure, sendSecure } from "./secure-channel";

export type BlobSyncWasm = NostrWasm & RosterHandshakeWasm;

/** Bytes asked for at a time. Bounded so one request cannot make a peer read a whole file. */
export const WINDOW = 1024 * 1024;
/** Bytes per data message: its base64 fits one Noise frame (secure-channel CHUNK_BYTES). */
const SLICE = 23 * 1024;
/** A window that has not completed in this long is abandoned; its staged prefix is kept. */
const STALL_MS = 30_000;
/** Heartbeat: a `have` this often, and a peer silent for four of them is dropped. */
const HEARTBEAT_MS = 30_000;
/** How often this device re-lists what it holds, announcing at once if that changed. Hosts
 * with no hook on a local attach rely on this to offer a new file within seconds. */
const TICK_MS = 10_000;
/** How long a peer that failed to deliver a file is passed over for it. */
const RETRY_AFTER_MS = 2 * 60_000;

/** One attachment a device should hold, from its vault's manifest. */
export interface WantedBlob {
	hash: string;
	/** Sealed length, from the record: what a complete transfer must add up to. */
	size: number;
}

/** What a vault should hold, from its entries payload: every live attachment, once. */
export function wantedFromPayload(payload: EntriesPayload): WantedBlob[] {
	const bySize = new Map<string, number>();
	for (const record of liveFiles(payload)) {
		bySize.set(record.hash, record.size);
	}
	return [...bySize].map(([hash, size]) => ({ hash, size }));
}

export interface BlobSyncOptions {
	relayUrl: string;
	iceUrl?: string;
	groupKeyB64: string;
	devicePrivB64: string;
	devicePubB64: string;
	roster: RosterPayload;
	fetchLocalRoster?: () => Promise<string>;
	wasm: BlobSyncWasm;
	report: (status: string) => void;
	/** This vault's attachment store. */
	blobs: BlobStore;
	/** Every live attachment this vault's manifest names. Read on each poke, so a merge that adds
	 * one is fetched without restarting the session. */
	wanted: () => Promise<WantedBlob[]>;
	/** A blob arrived and was verified. */
	onReceived?: (hash: string) => void;
	/** Find peers over the relay mesh, direct connections only. Default true; off where there is
	 * no WebRTC to connect with (Firefox), and in tests. */
	relay?: boolean;
	/** Pipes this host already holds to peers, beside the mesh: the desktop app's local link. */
	localSources?: PeerSource[];
}

export interface BlobSyncSession extends MeshSession {
	/** Re-read the manifest and the store: after a merge, an attach, or a restore. */
	poke(): void;
	/** Why each of these files hasn't arrived. Files this device holds are left out. */
	status(hashes: string[]): Promise<Record<string, FileTransferStatus>>;
}

/** Why a file this device lacks hasn't arrived, as far as its session can see. See
 * docs/file-attachments.md ("Saying why a file has not arrived"). */
export type FileTransferStatus =
	| { state: "downloading"; from: string | null; received: number; size: number }
	| { state: "queued"; from: string | null }
	| { state: "retrying"; from: string | null }
	| { state: "unreachable" }
	| { state: "not-on-connected" }
	| { state: "desktop-only" }
	| { state: "waiting" };

/** What a session knows when asked, for statusOf. */
export interface StatusSnapshot {
	now: number;
	active: { hash: string; from: string; received: number; size: number } | null;
	/** Connected peers, and what each last said it holds. */
	peers: { pub: string; has: ReadonlySet<string> }[];
	/** `${pub}:${hash}` -> when that peer may be tried for that hash again. */
	passOver: ReadonlyMap<string, number>;
	/** The relay mesh found a device and never connected to it. */
	unreachable: boolean;
	/** No WebRTC here: only a local link (the desktop app) can bring a file. */
	linkOnly: boolean;
	label(pub: string): string | null;
}

/**
 * One missing file's status. A device that can't be reached outranks connected ones that don't
 * hold the file, since it may be the one that does. Pure, so each case is tested on its own.
 */
export function statusOf(hash: string, s: StatusSnapshot): FileTransferStatus {
	if (s.active?.hash === hash) {
		const { from, received, size } = s.active;
		return { state: "downloading", from: s.label(from), received, size };
	}
	const holders = s.peers.filter((p) => p.has.has(hash));
	const ready = holders.find((p) => (s.passOver.get(`${p.pub}:${hash}`) ?? 0) <= s.now);
	if (ready) return { state: "queued", from: s.label(ready.pub) };
	if (holders[0]) return { state: "retrying", from: s.label(holders[0].pub) };
	if (s.unreachable) return { state: "unreachable" };
	if (s.peers.length > 0) return { state: "not-on-connected" };
	if (s.linkOnly) return { state: "desktop-only" };
	return { state: "waiting" };
}

/** A device found this long ago without a connection opening has had its chance (ICE takes
 * seconds); before that it is still connecting. */
const CONNECT_GRACE_MS = 20_000;
/** Devices say hello every 30 s, so one unheard from for longer than this has gone. */
const SEEN_FOR_MS = 2 * 60_000;

type Message =
	| { t: "have"; h: string[] }
	| { t: "want"; h: string; o: number; n: number }
	| { t: "data"; h: string; o: number; d: string }
	| { t: "nope"; h: string };

const HASH_RE = /^[0-9a-f]{64}$/;

function parse(json: string): Message | null {
	let m: unknown;
	try {
		m = JSON.parse(json);
	} catch {
		return null;
	}
	if (!m || typeof m !== "object") return null;
	const o = m as Record<string, unknown>;
	const isHash = (v: unknown): v is string => typeof v === "string" && HASH_RE.test(v);
	const isCount = (v: unknown): v is number =>
		typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
	switch (o.t) {
		case "have":
			return Array.isArray(o.h) ? { t: "have", h: o.h.filter(isHash) } : null;
		case "want":
			return isHash(o.h) && isCount(o.o) && isCount(o.n) && o.n <= WINDOW
				? { t: "want", h: o.h, o: o.o, n: o.n }
				: null;
		case "data":
			return isHash(o.h) && isCount(o.o) && typeof o.d === "string"
				? { t: "data", h: o.h, o: o.o, d: o.d }
				: null;
		case "nope":
			return isHash(o.h) ? { t: "nope", h: o.h } : null;
		default:
			return null;
	}
}

interface BlobPeer {
	/** One connection: the same device over the mesh and over the link is two peers. */
	key: string;
	pub: string;
	/** What this peer last said it holds. */
	has: Set<string>;
	lastSeen: number;
	send(m: Message): Promise<void>;
	close(): void;
}

interface Transfer {
	hash: string;
	peer: BlobPeer;
	offset: number;
	windowEnd: number;
	/** The current window's slices, appended to staging in one go once it is complete: one
	 * store write per window rather than per slice, which on mobile is a bridge call each. */
	pending: Uint8Array[];
	/** Settles the current window: true when it completed, false when it failed. */
	settle: ((ok: boolean) => void) | null;
}

export async function startBlobSync(opts: BlobSyncOptions): Promise<BlobSyncSession> {
	const peers = new Map<string, BlobPeer>();
	let held = new Set<string>();
	let wanted = new Map<string, number>(); // hash -> size
	let active: Transfer | null = null;
	/** `${peer}:${hash}` -> when that peer may be tried for that hash again. */
	const passOver = new Map<string, number>();
	let stopped = false;
	/** Set before a transfer's first await and cleared when it ends, so two cannot start. */
	let busy = false;
	/** Devices the relay mesh has seen, by its key for them, and whether a connection is open. */
	const seen = new Map<string, { firstAt: number; at: number; open: boolean }>();
	const onPeerState = (remote: string, state: "found" | "open" | "closed") => {
		const now = Date.now();
		seen.set(remote, {
			firstAt: seen.get(remote)?.firstAt ?? now,
			at: now,
			open: state === "open",
		});
	};

	/** Re-list what this device holds; true when that changed. */
	const relistHeld = async (): Promise<boolean> => {
		const before = held;
		const hashes = await opts.blobs.list();
		held = new Set(hashes);
		return held.size !== before.size || hashes.some((h) => !before.has(h));
	};
	const refresh = async () => {
		await relistHeld();
		wanted = new Map((await opts.wanted()).map((w) => [w.hash, w.size]));
	};

	const haveMessage = (): Message => ({ t: "have", h: [...held] });
	let lastAnnounce = 0;
	const announce = async () => {
		lastAnnounce = Date.now();
		const m = haveMessage();
		for (const peer of peers.values()) await peer.send(m).catch(() => {});
	};

	/** Start the next transfer this session can make. One at a time: a file at full speed beats
	 * several crawling, and it bounds what is staged at once. */
	const pump = () => {
		if (busy || stopped) return;
		const now = Date.now();
		for (const [hash, size] of wanted) {
			if (held.has(hash)) continue;
			const peer = [...peers.values()].find(
				(p) => p.has.has(hash) && (passOver.get(`${p.pub}:${hash}`) ?? 0) <= now,
			);
			if (!peer) continue;
			busy = true;
			void receive(hash, size, peer).finally(() => {
				busy = false;
				if (!stopped) pump();
			});
			return;
		}
	};

	const receive = async (hash: string, size: number, peer: BlobPeer) => {
		let receipt: BlobReceipt;
		try {
			receipt = await opts.blobs.receive(hash);
		} catch {
			// Already held after all (another path stored it): just refresh what we know.
			await refresh();
			return;
		}
		const transfer: Transfer = {
			hash,
			peer,
			offset: receipt.resumeFrom,
			windowEnd: receipt.resumeFrom,
			pending: [],
			settle: null,
		};
		active = transfer;
		const fail = (why: string) => {
			opts.report(`file ${hash.slice(0, 8)} from ${peer.pub.slice(0, 8)}: ${why}`);
			passOver.set(`${peer.pub}:${hash}`, Date.now() + RETRY_AFTER_MS);
		};
		try {
			while (transfer.offset < size && !stopped) {
				const n = Math.min(WINDOW, size - transfer.offset);
				transfer.windowEnd = transfer.offset + n;
				const done = new Promise<boolean>((resolve) => {
					transfer.settle = resolve;
				});
				const stall = setTimeout(() => transfer.settle?.(false), STALL_MS);
				await peer.send({ t: "want", h: hash, o: transfer.offset, n });
				const ok = await done;
				clearTimeout(stall);
				transfer.settle = null;
				if (!ok) {
					// Kept, not aborted: what was staged stays staged for the next try. This window's
					// slices were never written, so the prefix on disk is whole windows only.
					fail("stopped before the file was complete");
					return;
				}
				const window = new Uint8Array(transfer.offset - (transfer.windowEnd - n));
				let at = 0;
				for (const part of transfer.pending) {
					window.set(part, at);
					at += part.length;
				}
				transfer.pending = [];
				await receipt.append(window);
			}
			if (stopped) return;
			// The one check that matters: the whole file hashes to its own name, or it is not
			// stored. A wrong byte anywhere fails here and the staging is discarded.
			await receipt.commit();
			held.add(hash);
			opts.report(`received file ${hash.slice(0, 8)} (${size} bytes)`);
			opts.onReceived?.(hash);
			void announce();
		} catch (e) {
			fail(`rejected: ${(e as Error).message}`);
		} finally {
			if (active === transfer) active = null;
		}
	};

	const onData = async (peer: BlobPeer, m: Extract<Message, { t: "data" }>) => {
		const t = active;
		if (!t || t.peer !== peer || t.hash !== m.h || !t.settle) return;
		// In order and within the window, or the transfer is wrong: data channels are ordered, so
		// anything else is a confused or hostile peer, and a gap would never hash right anyway.
		const bytes = base64ToBytes(m.d);
		if (m.o !== t.offset || t.offset + bytes.length > t.windowEnd) {
			t.settle(false);
			return;
		}
		t.pending.push(bytes);
		t.offset += bytes.length;
		if (t.offset === t.windowEnd) t.settle(true);
	};

	/** Answer a want, if this peer may have it and we hold it. */
	const onWant = async (peer: BlobPeer, m: Extract<Message, { t: "want" }>) => {
		// Revocation applies mid-session: a device removed from the roster gets no more bytes.
		if (!inRoster(await currentRoster(opts), peer.pub)) {
			peer.close();
			return;
		}
		// The store, not `held`: a file attached since the last refresh is still ours to serve.
		const total = await opts.blobs.size(m.h);
		if (total === null || m.o >= total) {
			await peer.send({ t: "nope", h: m.h });
			return;
		}
		const window = await opts.blobs.read(m.h, m.o, Math.min(m.n, total - m.o));
		for (let at = 0; at < window.length; at += SLICE) {
			const slice = window.subarray(at, at + SLICE);
			await peer.send({ t: "data", h: m.h, o: m.o + at, d: bytesToBase64(slice) });
		}
	};

	const onPeer = async (peerSession: PeerSession, path: number) => {
		const authed = await authenticatePeer(opts, peerSession);
		if (!authed || stopped) return;
		const { peerPub, sessionId } = authed;
		const key = `${path}:${peerPub}`;
		const channel: Channel = peerSession.channel;
		// One message at a time per session: Noise frames must be decrypted in the order they
		// were encrypted, so concurrent sends would interleave and break the stream.
		let sendTail: Promise<void> = Promise.resolve();
		let wakeAbort: (() => void) | null = null;
		const aborted = new Promise<null>((resolve) => {
			wakeAbort = () => resolve(null);
		});
		const peer: BlobPeer = {
			key,
			pub: peerPub,
			has: new Set(),
			lastSeen: Date.now(),
			send(m) {
				const run = sendTail.then(() =>
					sendSecure(channel, opts.wasm, sessionId, JSON.stringify(m)),
				);
				sendTail = run.catch(() => {});
				return run;
			},
			close() {
				wakeAbort?.();
				peerSession.close();
				if (peers.get(key) === peer) peers.delete(key);
				if (active?.peer === peer) active.settle?.(false);
			},
		};
		// A reconnect over the same path supersedes; the other path, if any, is left alone.
		peers.get(key)?.close();
		peers.set(key, peer);
		opts.report(`file peer ${peerPub.slice(0, 8)} connected`);
		await peer.send(haveMessage());

		const recvFrame = () => Promise.race([channel.recv(), aborted]);
		for (;;) {
			let json: string | null;
			try {
				json = await recvSecure(recvFrame, opts.wasm, sessionId);
			} catch {
				break;
			}
			if (json === null || stopped) break;
			peer.lastSeen = Date.now();
			const m = parse(json);
			if (!m) continue;
			if (m.t === "have") {
				peer.has = new Set(m.h);
				pump();
			} else if (m.t === "want") {
				await onWant(peer, m).catch(() => {});
			} else if (m.t === "data") {
				await onData(peer, m);
			} else if (m.t === "nope") {
				peer.has.delete(m.h);
				if (active?.peer === peer && active.hash === m.h) active.settle?.(false);
			}
		}
		peer.close();
	};

	await refresh();
	const shutdown = () => {
		stopped = true;
		clearInterval(heartbeat);
		active?.settle?.(false);
		for (const peer of [...peers.values()]) peer.close();
		peers.clear();
	};
	// One session over every path, so one transfer state: two sessions sharing a store could
	// stage the same file twice at once.
	const sources: (PeerSource | undefined)[] = [
		...(opts.relay === false ? [] : [undefined]),
		...(opts.localSources ?? []),
	];
	const paths: MeshSession[] = [];
	for (const [path, peerSource] of sources.entries()) {
		// Each path on its own: a relay that is down must not cost the local link.
		try {
			paths.push(
				await startMeshSession({
					relayUrl: opts.relayUrl,
					iceUrl: opts.iceUrl,
					groupKeyB64: opts.groupKeyB64,
					roomLabel: "bramble/blob",
					wasm: opts.wasm,
					report: opts.report,
					epochRooms: true,
					webrtcOnly: true,
					peerSource,
					onPeerState: peerSource ? undefined : onPeerState,
					onPeer: (peer) => onPeer(peer, path),
				}),
			);
		} catch (e) {
			opts.report(
				`file sync: ${peerSource ? "local link" : "relay"} unavailable: ${(e as Error).message}`,
			);
		}
	}
	const heartbeat = setInterval(() => {
		const now = Date.now();
		for (const [remote, s] of seen) if (now - s.at > SEEN_FOR_MS) seen.delete(remote);
		for (const peer of [...peers.values()]) {
			if (now - peer.lastSeen > 4 * HEARTBEAT_MS) {
				opts.report(`file peer ${peer.pub.slice(0, 8)} idle, dropping`);
				peer.close();
			}
		}
		void relistHeld()
			.then((changed) => {
				if (changed || Date.now() - lastAnnounce >= HEARTBEAT_MS) return announce();
			})
			.catch(() => {});
	}, TICK_MS);

	return {
		stop() {
			if (stopped) return;
			shutdown();
			for (const path of paths) path.stop();
		},
		poke() {
			void refresh()
				.then(announce)
				.then(() => pump())
				.catch(() => {});
		},
		async status(hashes) {
			const now = Date.now();
			const roster = await currentRoster(opts);
			const snapshot: StatusSnapshot = {
				now,
				active: active && {
					hash: active.hash,
					from: active.peer.pub,
					received: active.offset,
					size: wanted.get(active.hash) ?? active.windowEnd,
				},
				peers: [...peers.values()],
				passOver,
				unreachable: [...seen.values()].some(
					(d) => !d.open && now - d.at < SEEN_FOR_MS && now - d.firstAt >= CONNECT_GRACE_MS,
				),
				linkOnly: opts.relay === false,
				label: (pub) => roster.devices.find((d) => d.publicKey === pub)?.label || null,
			};
			const out: Record<string, FileTransferStatus> = {};
			for (const hash of hashes) if (!held.has(hash)) out[hash] = statusOf(hash, snapshot);
			return out;
		},
	};
}
