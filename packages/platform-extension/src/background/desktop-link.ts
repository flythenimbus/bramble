/// <reference types="chrome" />

// The extension's half of the link to the Bramble desktop app.
//
// Chrome spawns a small proxy binary (declared in a native-messaging host manifest the desktop
// app installs) and relays framed JSON to it over stdio; the proxy passes those bytes to the
// app's local socket. From here that is all one pipe: `connectNative` in, replies out.
//
// Pairing is Noise_XXpsk3 keyed on a short code the user carries from the desktop app to here.
// The code is the whole authentication. An approval prompt on the other end could only ever
// display what a caller *claimed* to be, so a malicious local process could assert any
// extension id and race this one to be the request the user approved; a code it does not hold
// means its handshake fails outright. Afterwards each side has the other's static key and
// reconnects over Noise_KK with no user involvement. See docs/desktop-port.md.
//
// The crypto lives in the offscreen document, because MV3's service worker has no WASM host.
// This module owns the port and the persistence and relays handshake messages across.

import { api } from "../platform-api";
import { sendToOffscreen } from "./offscreen-client";
import { extensionOnly, on } from "./router";

/** Must match the `name` in the host manifest the desktop app writes. */
const HOST_NAME = "app.bramble.desktop";

/** Wire protocol version, checked by the app. */
const PROTOCOL_VERSION = 1;

const STORAGE_KEY = "desktopLink";

/** How long a request over the held link waits. A fill the user is watching, so short. */
const ASK_TIMEOUT_MS = 10_000;

/** What survives a pairing: our identity, and who we are entitled to talk to. */
interface LinkState {
	privateKey: string;
	publicKey: string;
	/** The desktop app's static key, learned during pairing. Without it there is nothing for
	 * a later KK handshake to authenticate against. */
	appPublicKey: string;
	pairedAt: number;
}

async function loadState(): Promise<LinkState | null> {
	const stored = (await api.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as LinkState | undefined;
	return stored?.privateKey && stored?.appPublicKey ? stored : null;
}

/** A single request/response over a freshly spawned host. */
class NativeSession {
	private port: chrome.runtime.Port;
	private queue: Array<(value: any) => void> = [];
	private failed: string | null = null;
	/**
	 * Frames the app sent unprompted, rather than as the answer to a request.
	 *
	 * Everything used to be request/response, so the next frame to arrive WAS the answer to the
	 * outstanding request. Sync broke that: the app pushes when it has something to say, and a
	 * pushed frame landing between a request and its answer would be handed back as that answer,
	 * leaving the session one frame out of step for as long as it lived. Whoever installs this
	 * takes those frames out of the queue's path.
	 */
	private onUnsolicited: ((msg: any) => boolean) | null = null;

	constructor() {
		this.port = api.runtime.connectNative(HOST_NAME);
		this.port.onMessage.addListener((msg) => {
			// The hook decides: it returns true when it has claimed the frame. Anything it does
			// not claim is an answer, and goes to whoever is waiting.
			if (this.onUnsolicited?.(msg)) return;
			const next = this.queue.shift();
			if (next) next(msg);
		});
		this.port.onDisconnect.addListener(() => {
			// Chrome reports a missing host, a manifest that does not name this extension, and
			// a host that exited all as the same bare disconnect, so this is the only signal
			// there is. lastError carries what little detail exists.
			this.failed = api.runtime.lastError?.message ?? "disconnected";
			for (const pending of this.queue.splice(0)) pending(null);
		});
	}

	/** Send one frame and wait for the reply. */
	request(message: Record<string, unknown>): Promise<any> {
		if (this.failed) return Promise.reject(new Error(this.failed));
		return new Promise((resolve, reject) => {
			this.queue.push((value) => {
				if (value === null) reject(new Error(this.failed ?? "disconnected"));
				else resolve(value);
			});
			try {
				this.port.postMessage(message);
			} catch (e) {
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	/** Send without expecting a reply, for the last message of a handshake. */
	send(message: Record<string, unknown>): void {
		this.port.postMessage(message);
	}

	/** Claim frames the app sent unprompted. See `onUnsolicited`. */
	intercept(handler: (msg: any) => boolean): void {
		this.onUnsolicited = handler;
	}

	/** Whether the pipe has died, so a held session knows to rebuild rather than hang. */
	get dead(): boolean {
		return this.failed !== null;
	}

	onDead(cb: () => void): void {
		this.port.onDisconnect.addListener(cb);
	}

	close(): void {
		this.port.disconnect();
	}
}

async function offscreen(type: string, payload?: Record<string, unknown>): Promise<any> {
	const res = await sendToOffscreen(payload ? { type, payload } : { type });
	if (!res.ok) throw new Error(res.error ?? `${type} failed`);
	return res.data;
}

/**
 * Pair with the desktop app using the code the user is reading off it.
 *
 * Throws with something the UI can show. A wrong code fails inside the AEAD rather than at any
 * check of ours, so it surfaces as a refusal from the app rather than a distinguishable error,
 * which is deliberate on the app's side.
 */
export async function pairWithDesktop(code: string): Promise<LinkState> {
	const kp = (await offscreen("SYNC_GENERATE_KEYPAIR")) as {
		privateKey: string;
		publicKey: string;
	};
	const psk = await pskFor(code);
	const start = (await offscreen("LINK_ENROLL_INITIATOR", {
		privateKey: kp.privateKey,
		psk,
	})) as { sessionId: number; message: string };

	const session = new NativeSession();
	try {
		session.send({
			kind: "pair",
			v: PROTOCOL_VERSION,
			label: `chrome-extension://${api.runtime.id}`,
		});
		const reply = await session.request({ message: start.message });
		if (!reply?.ok) throw new Error("The desktop app refused the code.");

		const next = (await offscreen("LINK_READ", {
			sessionId: start.sessionId,
			message: reply.message,
		})) as { message?: string; done: boolean };
		if (!next.message) throw new Error("Pairing did not complete.");

		const done = await session.request({ message: next.message });
		if (!done?.done) throw new Error("The desktop app refused the code.");

		const appPublicKey = (await offscreen("LINK_REMOTE_STATIC", {
			sessionId: start.sessionId,
		})) as string;

		const state: LinkState = {
			privateKey: kp.privateKey,
			publicKey: kp.publicKey,
			appPublicKey,
			pairedAt: Date.now(),
		};
		await api.storage.local.set({ [STORAGE_KEY]: state });
		return state;
	} finally {
		await offscreen("LINK_CLOSE", { sessionId: start.sessionId }).catch(() => {});
		session.close();
	}
}

/** One authenticated request. Opens a session, asks, closes.
 *
 * A session per request rather than a held-open one, for now: the browser spawns a fresh proxy
 * anyway, and a long-lived port would need reconnect handling for a link that is idle most of
 * the time. */
export async function askDesktop(request: Record<string, unknown>): Promise<any> {
	const state = await loadState();
	if (!state) throw new Error("Not linked to the desktop app.");

	// Ride the held link when sync has one open. A second connection would displace it as the
	// target for the app's pushes, and closing this short-lived one would take that queue with
	// it, so sync would go quiet with nothing reporting a fault.
	const link = await ensureHeld();
	if (link) return askOverHeld(link, request);

	const start = (await offscreen("LINK_START_INITIATOR", {
		privateKey: state.privateKey,
		remotePublicKey: state.appPublicKey,
	})) as { sessionId: number; message: string };

	const session = new NativeSession();
	try {
		session.send({ kind: "hello", v: PROTOCOL_VERSION, publicKey: state.publicKey });
		const reply = await session.request({ message: start.message });
		if (reply?.ok !== true || reply?.done !== true) throw new Error("The desktop app refused.");
		if (reply.message) {
			await offscreen("LINK_READ", { sessionId: start.sessionId, message: reply.message });
		}

		const sealed = (await offscreen("LINK_SEAL", {
			sessionId: start.sessionId,
			plaintext: JSON.stringify(request),
		})) as string;
		const answer = await session.request({ sealed });
		const plain = (await offscreen("LINK_OPEN", {
			sessionId: start.sessionId,
			sealed: answer.sealed,
		})) as string;
		return JSON.parse(plain);
	} finally {
		await offscreen("LINK_CLOSE", { sessionId: start.sessionId }).catch(() => {});
		session.close();
	}
}

/** One request over the held link, answered by routeInbound. */
async function askOverHeld(link: HeldLink, request: Record<string, unknown>): Promise<any> {
	const sealed = (await offscreen("LINK_SEAL", {
		sessionId: link.sessionId,
		plaintext: JSON.stringify(request),
	})) as string;
	const answer = new Promise<unknown>((resolve, reject) => {
		// A dead pipe would otherwise leave this pending forever, and the caller is a fill the
		// user is waiting on.
		const timer = setTimeout(() => {
			pendingAnswer = null;
			reject(new Error("The desktop app did not answer."));
		}, ASK_TIMEOUT_MS);
		pendingAnswer = (value) => {
			clearTimeout(timer);
			resolve(value);
		};
	});
	link.session.send({ sealed });
	return answer;
}

/** Reconnect over KK, which is what every session after the first one does. */
export async function connectToDesktop(): Promise<boolean> {
	const state = await loadState();
	if (!state) return false;

	const start = (await offscreen("LINK_START_INITIATOR", {
		privateKey: state.privateKey,
		remotePublicKey: state.appPublicKey,
	})) as { sessionId: number; message: string };

	const session = new NativeSession();
	try {
		session.send({ kind: "hello", v: PROTOCOL_VERSION, publicKey: state.publicKey });
		const reply = await session.request({ message: start.message });
		if (reply?.ok !== true || reply?.done !== true) return false;

		// KK is two messages. Feeding the responder's reply back is what puts this side into
		// transport mode; without it the session stays mid-handshake, which looks like success
		// right up until something tries to encrypt over it.
		if (reply.message) {
			await offscreen("LINK_READ", { sessionId: start.sessionId, message: reply.message });
		}
		return true;
	} finally {
		await offscreen("LINK_CLOSE", { sessionId: start.sessionId }).catch(() => {});
		session.close();
	}
}

/**
 * The one held-open link to the app, opened when this browser syncs with it.
 *
 * Delegation opens a session per request, which is fine for a link that is idle most of the
 * time. Sync cannot: the app pushes frames when it has something to say, so somebody has to be
 * listening. Held open while sync runs and torn down with it.
 *
 * There must be at most ONE connection from this extension at a time. The app keys its outbound
 * queue by our static key, so a second connection displaces the first as the target for pushes,
 * and closing that short-lived one takes the queue with it: sync would go quiet until the next
 * reconnect, with nothing on either side reporting a fault. So while this is open, requests ride
 * it instead of spawning their own.
 */
interface HeldLink {
	session: NativeSession;
	/** The Noise session id, held in the offscreen where the crypto lives. */
	sessionId: number;
	/** Opens arrive in order and must be DECRYPTED in order: Noise numbers its transport frames,
	 * so two opens in flight at once can complete out of order and fail. */
	inbound: Promise<void>;
}

let held: HeldLink | null = null;

/** Where a frame from the app goes. Set while sync is running. */
let onSyncFrame: ((frame: string) => void) | null = null;

/** Open the link and keep it open, routing the app's sync frames to `onFrame`. */
export async function openSyncLink(onFrame: (frame: string) => void): Promise<boolean> {
	onSyncFrame = onFrame;
	return (await ensureHeld()) !== null;
}

/** Close the held link. Delegation goes back to a session per request. */
export async function closeSyncLink(): Promise<void> {
	onSyncFrame = null;
	const link = held;
	held = null;
	if (!link) return;
	await offscreen("LINK_CLOSE", { sessionId: link.sessionId }).catch(() => {});
	link.session.close();
}

/** Hand one sync frame to the app. False when the link is down, which is not an error: the
 * desktop app may simply not be running, and sync carries on over the relay. */
export async function sendSyncFrame(frame: string): Promise<boolean> {
	const link = await ensureHeld();
	if (!link) return false;
	try {
		const sealed = (await offscreen("LINK_SEAL", {
			sessionId: link.sessionId,
			plaintext: JSON.stringify({ op: "sync", frame }),
		})) as string;
		link.session.send({ sealed });
		return true;
	} catch {
		await dropHeld();
		return false;
	}
}

/** The held link, opening one if sync is running and there is none. */
async function ensureHeld(): Promise<HeldLink | null> {
	if (held && !held.session.dead) return held;
	if (held) await dropHeld();
	if (!onSyncFrame) return null; // sync is not running; nothing should hold the pipe open

	const state = await loadState();
	if (!state) return null;
	const start = (await offscreen("LINK_START_INITIATOR", {
		privateKey: state.privateKey,
		remotePublicKey: state.appPublicKey,
	})) as { sessionId: number; message: string };

	const session = new NativeSession();
	try {
		session.send({ kind: "hello", v: PROTOCOL_VERSION, publicKey: state.publicKey });
		const reply = await session.request({ message: start.message });
		if (reply?.ok !== true || reply?.done !== true) throw new Error("refused");
		// KK is two messages; feeding the reply back is what puts this side in transport mode.
		if (reply.message) {
			await offscreen("LINK_READ", { sessionId: start.sessionId, message: reply.message });
		}
	} catch {
		await offscreen("LINK_CLOSE", { sessionId: start.sessionId }).catch(() => {});
		session.close();
		return null;
	}

	const link: HeldLink = { session, sessionId: start.sessionId, inbound: Promise.resolve() };
	session.intercept((msg) => {
		if (typeof msg?.sealed !== "string") return false;
		// Claimed BEFORE it is opened, and opened on a chain, because deciding what a frame is
		// requires decrypting it and decryption has to happen in arrival order.
		link.inbound = link.inbound.then(() => routeInbound(link, msg.sealed as string));
		return true;
	});
	session.onDead(() => {
		// Only if it is still the current link: a rebuild may already have replaced it.
		if (held === link) held = null;
	});
	held = link;
	return link;
}

/** Open one inbound frame and dispatch it: a sync frame to sync, anything else to the request
 * waiting for it. */
async function routeInbound(link: HeldLink, sealed: string): Promise<void> {
	let parsed: { sync?: string };
	try {
		const plain = (await offscreen("LINK_OPEN", {
			sessionId: link.sessionId,
			sealed,
		})) as string;
		parsed = JSON.parse(plain) as { sync?: string };
	} catch {
		// An unopenable frame means this session is out of step; rebuilding is the only recovery.
		await dropHeld();
		return;
	}
	if (typeof parsed.sync === "string") {
		onSyncFrame?.(parsed.sync);
		return;
	}
	// An answer: hand the plaintext to whoever asked. Requests over the held link resolve here.
	pendingAnswer?.(parsed);
	pendingAnswer = null;
}

/** The request waiting on the held link, if any. One at a time: askDesktop awaits each call. */
let pendingAnswer: ((value: unknown) => void) | null = null;

async function dropHeld(): Promise<void> {
	const link = held;
	held = null;
	if (!link) return;
	await offscreen("LINK_CLOSE", { sessionId: link.sessionId }).catch(() => {});
	link.session.close();
}

/**
 * The 32-byte PSK the handshake wants, derived from the typed code.
 *
 * Must match `psk_for` in the desktop app's src-tauri/src/pairing.rs byte for byte: same
 * domain-separation string, same case folding, same base64. If these drift the handshake
 * simply fails, with no clue as to why.
 */
const PSK_INFO = "bramble/desktop/extension-pairing/psk/v1";

async function pskFor(code: string): Promise<string> {
	const encoder = new TextEncoder();
	const input = encoder.encode(PSK_INFO + code.trim().toUpperCase());
	const digest = await crypto.subtle.digest("SHA-256", input);
	return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/** Forget the desktop app. The next KK handshake has nothing to authenticate with. */
export async function unlinkDesktop(): Promise<void> {
	await api.storage.local.remove(STORAGE_KEY);
}

export async function desktopLinkStatus(): Promise<{ paired: boolean; pairedAt?: number }> {
	const state = await loadState();
	return state ? { paired: true, pairedAt: state.pairedAt } : { paired: false };
}

on(
	"LINK_SYNC_SEND",
	// The offscreen runs sync but the port lives here, so its outbound frames come through this.
	// False rather than an error when the link is down: the app may simply not be running, and
	// sync carries on over the relay.
	extensionOnly(async (message) => {
		const frame = (message.payload as { frame?: unknown } | undefined)?.frame;
		if (typeof frame !== "string") return { ok: false, error: "LINK_SYNC_SEND requires a frame" };
		return { ok: true, data: await sendSyncFrame(frame) };
	}),
);

on(
	"DESKTOP_LINK_PAIR",
	extensionOnly(async (message) => {
		const code = String((message as { code?: unknown }).code ?? "");
		if (!code) return { ok: false, error: "no code" };
		const state = await pairWithDesktop(code);
		return { ok: true, data: { publicKey: state.publicKey, pairedAt: state.pairedAt } };
	}),
);

on(
	"DESKTOP_LINK_CONNECT",
	extensionOnly(async () => ({ ok: true, data: await connectToDesktop() })),
);

on(
	"DESKTOP_LINK_STATUS",
	extensionOnly(async () => ({ ok: true, data: await desktopLinkStatus() })),
);

on(
	"DESKTOP_LINK_QUERY",
	extensionOnly(async (message) => {
		const hostname = String((message as { hostname?: unknown }).hostname ?? "");
		if (!hostname) return { ok: false, error: "no hostname" };
		return { ok: true, data: await askDesktop({ op: "query", hostname }) };
	}),
);

on(
	"DESKTOP_LINK_UNLINK",
	extensionOnly(async () => {
		await unlinkDesktop();
		return { ok: true };
	}),
);
