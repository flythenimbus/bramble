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

import { linkNonceCommit, linkSas, linkSasMaterial } from "@core/sync/link-sas";
import type { PairingSas } from "@core/sync/pairing-sas";
import { syncKeyFor } from "@core/sync/sync-keys";
import { bytesToBase64 } from "@core/util/bytes";
import { defaultDeviceLabel } from "@core/util/device-label";
import { parseRegistry, VAULT_REGISTRY_KEY } from "@core/vault/vault-registry";
import { api, disconnectReason } from "../platform-api";
import { isExtensionSender } from "../sender";
import { LAST_OPENED_VAULT_KEY } from "../session-keys";
import { extensionStorage } from "../storage";
import { sendToOffscreen } from "./offscreen-client";
import { extensionOnly, on } from "./router";
import { getActiveVaultId } from "./vek-store";

/** Must match the `name` in the host manifest the desktop app writes. */
const HOST_NAME = "app.bramble.desktop";

/** Must match `NATIVE_PROXY_PORT` in ../desktop-link.ts (page side). */
const NATIVE_PROXY_PORT = "link-native-proxy";

/** Wire protocol version, checked by the app. */
const PROTOCOL_VERSION = 1;

/** The single link an earlier build kept for the whole profile. Each vault now has its own, at
 * `linkKeyFor(vaultId)`, as each has its own sync identity. */
const STORAGE_KEY = "desktopLink";

const linkKeyFor = (vaultId: string) => `${STORAGE_KEY}:${vaultId}`;

/** What the app last said its sync key is, kept per link, so it cannot outlive or cross one. A
 * public key. */
const appSyncKeyFor = (link: { publicKey: string }) => `linkAppSyncKey:${link.publicKey}`;

/** What the app tells a browser no vault there is linked to. Must match `UNLINKED` in
 * pairing.rs. */
const UNLINKED = "not linked to this app";
/** What it tells a browser whose vault is not the one open. Must match `NOT_LINKED`. */
const NOT_LINKED = "not linked to the open vault";

/** The app's sealed refusal, its first frame on a session for a browser it does not admit. */
const refusedBy = (answer: unknown): string | null => {
	const a = answer as { ok?: unknown; error?: unknown } | null;
	return a?.ok === false && (a.error === UNLINKED || a.error === NOT_LINKED) ? a.error : null;
};

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

/**
 * Whether the user has allowed native messaging.
 *
 * `permissions.contains` is the only honest answer. Do NOT substitute a check for the API being
 * callable: the two disagree, in both directions and for as long as a context lives.
 */
async function permitted(): Promise<boolean> {
	try {
		return await api.permissions.contains({ permissions: ["nativeMessaging"] });
	} catch {
		// No permissions API at all (some hosts, and the unit-test stubs). Nothing to promise.
		return false;
	}
}

/**
 * Whether THIS worker can open a native pipe right now, which is a different question.
 *
 * Two things have to be true and they fail independently. `permitted()` is whether the user has
 * allowed it. The binding is whether this particular context was created late enough to have been
 * handed the API: Chromium fixes bindings at context creation, so a worker that was already
 * running when the grant happened answers "allowed, and I still cannot". That is not a permission
 * test and must not be used as one; it is this worker asking what it is able to do.
 *
 * Nothing can repair it in place. The worker gains the binding when it next starts, and
 * background.ts calls openDesktopLink() on every start, so the link comes up on its own, as long
 * as this worker is let go and something wakes the next one: see awaitNextWorker.
 */
async function canOpenNativePipe(): Promise<boolean> {
	return typeof api.runtime.connectNative === "function" && (await permitted());
}

async function loadLink(key: string): Promise<LinkState | null> {
	const stored = (await api.storage.local.get(key))[key] as LinkState | undefined;
	return stored?.privateKey && stored?.appPublicKey ? stored : null;
}

/** Forget a stored link, and what was learned through it. */
async function removeLink(key: string): Promise<void> {
	const link = await loadLink(key);
	await api.storage.local.remove(key);
	if (link) await api.storage.local.remove(appSyncKeyFor(link));
}

/**
 * A link both screens confirmed that has not attached to a vault yet: the pairing is complete
 * only once the browser holds the desktop's vault. In memory, so a worker that restarts mid-copy
 * abandons it, and the app forgets its half when its window closes.
 */
let inProgress: { state: LinkState; listed: boolean } | null = null;

/** Which link a session speaks as: a vault's own, the single link an earlier build kept
 * (`legacy`), or the one in progress (`vaultId` null). Read once, so a vault change mid-connect
 * cannot relabel it. */
interface LinkSource {
	state: LinkState;
	legacy: boolean;
	vaultId: string | null;
}

/** The vault whose link to hold: the open one, else, while locked, the one the browser would
 * unlock into. Filling from the app while locked is the link's point. */
async function linkVault(): Promise<string | null> {
	const open = getActiveVaultId();
	if (open) return open;
	const last = (await api.storage.local.get(LAST_OPENED_VAULT_KEY))[LAST_OPENED_VAULT_KEY];
	return typeof last === "string" ? last : null;
}

/** `vaultId`'s own link, else the single link an earlier build kept, which works as it did until
 * `adoptLegacyLink` places it. */
async function vaultLink(vaultId: string | null): Promise<LinkSource | null> {
	const own = vaultId ? await loadLink(linkKeyFor(vaultId)) : null;
	if (own) return { state: own, legacy: false, vaultId };
	const legacy = await loadLink(STORAGE_KEY);
	return legacy ? { state: legacy, legacy: true, vaultId } : null;
}

/** The link to speak with now: the one being made, else the vault's (`linkVault`). */
async function linkSource(): Promise<LinkSource | null> {
	if (inProgress) return { state: inProgress.state, legacy: false, vaultId: null };
	return vaultLink(await linkVault());
}

/** Bumped whenever which link should be held changes, so a connect begun before it is dropped
 * rather than held. */
let linkGen = 0;

async function currentLink(): Promise<LinkState | null> {
	return (await linkSource())?.state ?? null;
}

/**
 * Give the single link an earlier build kept to the vault that syncs with the app: the one whose
 * roster holds the app's sync identity. With none, it goes and the user links again. The app has
 * one identity for all its vaults, so with more than one such vault the link waits for proof
 * (`desktopLinkProven`). Unanswered, it stays as it was.
 */
async function adoptLegacyLink(link: HeldLink): Promise<void> {
	const legacy = await loadLink(STORAGE_KEY);
	if (!legacy) return;
	const answer = await askOverHeld(link, { op: "syncIdentity" }).catch(() => null);
	const identity = answer?.ok === true ? answer.identity : null;
	if (typeof identity !== "string") return;
	const homes: string[] = [];
	try {
		const reg = parseRegistry(await extensionStorage.getMeta(VAULT_REGISTRY_KEY));
		for (const v of reg.vaults) {
			const group = (await extensionStorage.getMeta(syncKeyFor("sync.group", v.id))) as {
				roster?: { devices?: { publicKey: string }[] };
			} | null;
			if (group?.roster?.devices?.some((d) => d.publicKey === identity)) homes.push(v.id);
		}
	} catch {
		return; // unsure keeps
	}
	if (homes.length > 1) return;
	const [home] = homes;
	if (home) await placeLegacyLink(home, legacy);
	else await removeLink(STORAGE_KEY);
	if (home && home === link.vaultId) link.legacy = false;
	else if (held === link) await dropHeld();
}

/** The single link an earlier build kept is `vaultId`'s, unless that vault has its own. */
async function placeLegacyLink(vaultId: string, legacy: LinkState): Promise<void> {
	if (!(await loadLink(linkKeyFor(vaultId)))) {
		await api.storage.local.set({ [linkKeyFor(vaultId)]: legacy });
	}
	await api.storage.local.remove(STORAGE_KEY);
}

/**
 * Sync over the held link passed the app's roster check for `vaultId`, so the link it speaks is
 * that vault's pair. Places the single link an earlier build kept, when that is what is held.
 */
export async function desktopLinkProven(vaultId: string): Promise<void> {
	const link = held;
	if (!link?.legacy || link.vaultId !== vaultId) return;
	const legacy = await loadLink(STORAGE_KEY);
	if (!legacy) return;
	await placeLegacyLink(vaultId, legacy);
	link.legacy = false;
}

/** The app, under the session, knows nothing of the link this browser spoke with: let it go. */
async function forgetRefused(source: { vaultId: string | null; legacy: boolean }): Promise<void> {
	if (source.legacy) await removeLink(STORAGE_KEY);
	else if (source.vaultId) await removeLink(linkKeyFor(source.vaultId));
	else await abandonLink();
}

/**
 * What the handshakes need from a pipe to the desktop app, so the pairing state machine does not
 * care which end of the extension is holding it open.
 *
 * There are two, and the reason is the optional permission. Chromium fixes a context's API
 * bindings when the context is created, so a worker that was already running when the user granted
 * `nativeMessaging` never gains `connectNative` and cannot get it back without restarting. During
 * pairing the worker is exactly that worker, and the open pairing window is what stops it
 * restarting. So pairing borrows the transport from a page created after the grant, and everything
 * afterwards uses a direct session once the worker has restarted on its own.
 * See docs/desktop-link-optional-permission.md.
 */
interface LinkTransport {
	request(message: Record<string, unknown>): Promise<any>;
	send(message: Record<string, unknown>): void;
	close(): void;
	/** Claim frames the app sends unprompted, before they are taken for an answer. */
	intercept(handler: (msg: any) => boolean): void;
	/** Whether the pipe has died. */
	readonly dead: boolean;
	onDead(cb: () => void): void;
}

/**
 * A pipe whose native end lives in a page, relayed frame for frame over a runtime port.
 *
 * The page is a dumb pipe and deliberately so: it forwards opaque handshake frames and never
 * inspects them. Key generation, the Noise state machine and the write to storage all stay in the
 * background, so this adds a transport rather than a second implementation of pairing.
 */
class ProxiedSession implements LinkTransport {
	private queue: Array<(value: any) => void> = [];
	private failed: string | null = null;
	private onUnsolicited: ((msg: any) => boolean) | null = null;
	private deadListeners: Array<() => void> = [];

	constructor(private port: chrome.runtime.Port) {
		port.onMessage.addListener((msg: { frame?: unknown; dead?: string }) => {
			if (typeof msg?.dead === "string") return this.die(msg.dead);
			if (this.onUnsolicited?.(msg?.frame)) return;
			const next = this.queue.shift();
			if (next) next(msg?.frame);
		});
		// The page closing mid-handshake is a dead pipe, not a silent stall: whoever is waiting
		// has to be told, or pairing hangs on a promise nothing will ever settle.
		port.onDisconnect.addListener(() => this.die("the pairing window closed"));
	}

	private die(reason: string): void {
		if (this.failed) return;
		this.failed = reason;
		for (const pending of this.queue.splice(0)) pending(null);
		for (const cb of this.deadListeners.splice(0)) cb();
	}

	intercept(handler: (msg: any) => boolean): void {
		this.onUnsolicited = handler;
	}

	get dead(): boolean {
		return this.failed !== null;
	}

	onDead(cb: () => void): void {
		if (this.failed) cb();
		else this.deadListeners.push(cb);
	}

	request(message: Record<string, unknown>): Promise<any> {
		if (this.failed) return Promise.reject(new Error(this.failed));
		return new Promise((resolve, reject) => {
			this.queue.push((value) => {
				if (value === null || value === undefined) reject(new Error(this.failed ?? "disconnected"));
				else resolve(value);
			});
			this.send(message);
		});
	}

	send(message: Record<string, unknown>): void {
		this.port.postMessage({ frame: message });
	}

	close(): void {
		// The page owns the native port. Disconnecting here would orphan the host process, so ask.
		try {
			this.port.postMessage({ release: true });
		} catch {
			// Its page has gone, and the native port with it.
		}
	}
}

/** Pipes pages have lent, by the id each port is named with. The page sends that id with the
 * one request it lent the pipe for. */
const lentPorts = new Map<string, chrome.runtime.Port>();

/** The lent pipe a page's request names, if any. */
const viaOf = (message: unknown): string | undefined => {
	const via = (message as { via?: unknown } | null)?.via;
	return typeof via === "string" ? via : undefined;
};

api.runtime.onConnect.addListener((port) => {
	if (!port.name.startsWith(`${NATIVE_PROXY_PORT}:`)) return;
	// A page-origin sender must never drive native messaging. Same rule as extensionOnly() on the
	// message router; a port is just another way in. See docs/sec-audit-7726.md (A3).
	if (!port.sender || !isExtensionSender(port.sender)) return port.disconnect();
	const id = port.name.slice(NATIVE_PROXY_PORT.length + 1);
	lentPorts.set(id, port);
	port.onDisconnect.addListener(() => {
		if (lentPorts.get(id) === port) lentPorts.delete(id);
	});
	// Acked so the page can wait for this before asking to pair. Without it the pair request can
	// overtake the connect and find no transport registered, which is a race that only shows up
	// on a cold worker.
	port.postMessage({ ready: true });
});

/** The pipe lent for this request, else this worker's own. A lent one is taken: the app reads a
 * connection as one session, so a second hello on it ends both. */
async function pipeFor(via: string | undefined): Promise<LinkTransport | null> {
	if (via !== undefined) {
		const lent = lentPorts.get(via);
		lentPorts.delete(via);
		if (lent) return new ProxiedSession(lent);
	}
	return (await canOpenNativePipe()) ? new NativeSession() : null;
}

/** A single request/response over a freshly spawned host. */
class NativeSession implements LinkTransport {
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
			// there is, with what little detail the browser gives.
			this.failed = disconnectReason(this.port);
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
		if (this.failed) cb();
		else this.port.onDisconnect.addListener(cb);
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
export async function pairWithDesktop(code: string, via?: string): Promise<LinkState> {
	const kp = (await offscreen("SYNC_GENERATE_KEYPAIR")) as {
		privateKey: string;
		publicKey: string;
	};
	const psk = await pskFor(code);
	const start = (await offscreen("LINK_ENROLL_INITIATOR", {
		privateKey: kp.privateKey,
		psk,
	})) as { sessionId: number; message: string };

	// The pairing window's transport when it lent one, which is the ordinary case on a browser
	// that has just granted the permission. A direct session otherwise: a worker that started
	// after the grant has the binding and needs no help.
	const session = await pipeFor(via);
	if (!session) {
		await offscreen("LINK_CLOSE", { sessionId: start.sessionId }).catch(() => {});
		throw new Error("This browser cannot reach the desktop app yet.");
	}
	try {
		session.send({
			kind: "pair",
			v: PROTOCOL_VERSION,
			// What the desktop lists this browser as. The same name sync gives it, rather than an
			// origin, which Firefox does not have in chrome-extension:// form.
			label: defaultDeviceLabel(),
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

		// Only an app from before the emoji link pairs by code, and it lists a browser as it pairs.
		return holdInProgress(
			{ privateKey: kp.privateKey, publicKey: kp.publicKey, appPublicKey, pairedAt: Date.now() },
			true,
		);
	} finally {
		await offscreen("LINK_CLOSE", { sessionId: start.sessionId }).catch(() => {});
		session.close();
	}
}

/** A link the user has not answered yet: the open pipe and handshake, waiting on "They match". */
interface PendingLink {
	session: LinkTransport;
	sessionId: number;
	privateKey: string;
	publicKey: string;
	appPublicKey: string;
	startedAt: number;
}

const pendingLinks = new Map<string, PendingLink>();

/** As long as the app's Connect window: an answer after that has nothing left to confirm. */
const LINK_PENDING_MS = 3 * 60_000;

/** Let go of a link the user walked away from: its pipe, and the session in the crypto host. */
export async function cancelDesktopLink(id: string): Promise<void> {
	const pending = pendingLinks.get(id);
	if (!pending) return;
	pendingLinks.delete(id);
	await offscreen("LINK_CLOSE", { sessionId: pending.sessionId }).catch(() => {});
	pending.session.close();
}

/** A native host that is not installed, in Chrome's words and in Firefox's. */
const HOST_MISSING = /not found|no such native application/i;

/**
 * Start linking with the desktop app by emoji. Resolves with the emoji to show once the
 * handshake is done, or `{ legacy: true }` for an app that predates this and only knows the code.
 *
 * Nothing is stored here: the app is trusted only after `confirmDesktopLink` with the user's
 * "They match" AND the app's own approval.
 */
export async function startDesktopLink(
	via?: string,
): Promise<{ id: string; sas: PairingSas } | { legacy: true }> {
	const kp = (await offscreen("SYNC_GENERATE_KEYPAIR")) as {
		privateKey: string;
		publicKey: string;
	};
	const start = (await offscreen("LINK_PAIR_INITIATOR", { privateKey: kp.privateKey })) as {
		sessionId: number;
		message: string;
	};
	const session = await pipeFor(via);
	if (!session) {
		await offscreen("LINK_CLOSE", { sessionId: start.sessionId }).catch(() => {});
		throw new Error("This browser cannot reach the desktop app yet.");
	}
	const fail = async () => {
		await offscreen("LINK_CLOSE", { sessionId: start.sessionId }).catch(() => {});
		session.close();
	};
	try {
		session.send({ kind: "link", v: PROTOCOL_VERSION, label: defaultDeviceLabel() });
		let reply: { ok?: boolean; message?: string } | undefined;
		try {
			reply = await session.request({ message: start.message });
		} catch (e) {
			// An older app closes on a hello it does not know, without a word. A host that is not
			// installed at all is a different failure, and says so.
			if (e instanceof Error && HOST_MISSING.test(e.message)) throw e;
			await fail();
			return { legacy: true };
		}
		if (!reply?.ok || !reply.message) {
			throw new Error("Open Connect a browser in the desktop app, then try again.");
		}
		const next = (await offscreen("LINK_READ", {
			sessionId: start.sessionId,
			message: reply.message,
		})) as { message?: string };
		if (!next.message) throw new Error("Linking did not complete.");
		const done = await session.request({ message: next.message });
		if (!done?.done) throw new Error("The desktop app refused.");

		// Commit to a nonce, learn the app's, then reveal ours, so a relay in the middle cannot pick
		// its inputs to make both screens' emoji agree.
		const sealedRequest = async (message: Record<string, unknown>) => {
			const sealed = (await offscreen("LINK_SEAL", {
				sessionId: start.sessionId,
				plaintext: JSON.stringify(message),
			})) as string;
			const answer = await session.request({ sealed });
			const plain = (await offscreen("LINK_OPEN", {
				sessionId: start.sessionId,
				sealed: answer?.sealed,
			})) as string;
			return JSON.parse(plain) as { ok?: boolean; nonce?: string };
		};
		const browserNonce = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
		const appNonce = await sealedRequest({
			op: "linkCommit",
			commit: await linkNonceCommit(browserNonce),
		});
		if (appNonce.ok !== true || typeof appNonce.nonce !== "string") {
			throw new Error("The desktop app refused.");
		}
		const revealed = await sealedRequest({ op: "linkReveal", nonce: browserNonce });
		if (revealed.ok !== true) throw new Error("The desktop app refused.");
		const hash = (await offscreen("LINK_HANDSHAKE_HASH", { sessionId: start.sessionId })) as string;
		const appPublicKey = (await offscreen("LINK_REMOTE_STATIC", {
			sessionId: start.sessionId,
		})) as string;
		const id = crypto.randomUUID();
		pendingLinks.set(id, {
			session,
			sessionId: start.sessionId,
			privateKey: kp.privateKey,
			publicKey: kp.publicKey,
			appPublicKey,
			startedAt: Date.now(),
		});
		setTimeout(() => void cancelDesktopLink(id), LINK_PENDING_MS);
		return { id, sas: await linkSas(await linkSasMaterial(hash, appNonce.nonce, browserNonce)) };
	} catch (e) {
		await fail();
		throw e;
	}
}

/**
 * The user's answer to the emoji. On a match, tell the app and wait for its own approval; only
 * then is the app's key stored. Anything else closes the link and stores nothing.
 *
 * Once both agree, the app serves this connection as a link, so it stays open as the held one.
 * A worker that got the permission this session cannot open a pipe of its own until it restarts,
 * and the vault copy rides the held link: closing this one left the copy nothing to ride.
 */
export async function confirmDesktopLink(id: string, matches: boolean): Promise<LinkState> {
	const pending = pendingLinks.get(id);
	if (!pending || Date.now() - pending.startedAt > LINK_PENDING_MS) {
		await cancelDesktopLink(id);
		throw new Error("That link is no longer in progress.");
	}
	pendingLinks.delete(id);
	const { session, sessionId } = pending;
	const close = async () => {
		await offscreen("LINK_CLOSE", { sessionId }).catch(() => {});
		session.close();
	};
	if (!matches) {
		await close();
		throw new Error("The symbols did not match, so nothing was linked.");
	}
	const link: HeldLink = {
		session,
		vaultId: null,
		legacy: false,
		sessionId,
		inbound: Promise.resolve(),
		outbound: Promise.resolve(),
		files: false,
		asking: Promise.resolve(),
		answer: null,
	};
	// Before the confirm goes out: the app may push the moment it answers, and a frame nobody
	// claims leaves Noise, which numbers every frame, out of step for the life of the link.
	session.intercept((msg) => {
		if (typeof msg?.sealed !== "string") return false;
		link.inbound = link.inbound.then(() => routeInbound(link, msg.sealed as string));
		return true;
	});
	const refused = "The desktop app did not approve the link.";
	try {
		// No timeout: this waits on a person. An app whose dialog closed after Approve shuts the
		// pipe rather than answer.
		const verdict = (await new Promise<unknown>((resolve, reject) => {
			link.answer = resolve;
			session.onDead(() => reject(new Error(refused)));
			sealAndSend(link, { op: "linkConfirm" }).catch(() => reject(new Error(refused)));
		})) as { ok?: boolean; paired?: boolean };
		if (verdict.ok !== true || verdict.paired !== true) throw new Error(refused);
		const state = await holdInProgress({
			privateKey: pending.privateKey,
			publicKey: pending.publicKey,
			appPublicKey: pending.appPublicKey,
			pairedAt: Date.now(),
		});
		// As connectHeld does, before the link is published.
		link.files = await askOverHeld(link, { op: "caps", caps: [CAP_FILES] })
			.then((answer) => Array.isArray(answer?.caps) && answer.caps.includes(CAP_FILES))
			.catch(() => false);
		session.onDead(() => {
			const wasHeld = held === link;
			if (wasHeld) held = null;
			// The vault copy runs in the page that lent this pipe: with it gone, nothing finishes.
			if (inProgress?.state === state && !inProgress.listed) void abandonLink();
			// Closed with that page, routinely: hold the vault's link again now, not at the keepalive.
			else if (wasHeld) void ensureHeld().catch(() => {});
		});
		held = link;
		linkWanted = true;
		startKeepalive();
		return state;
	} catch (e) {
		link.answer = null;
		await close();
		throw e;
	}
}

/** One authenticated request. Opens a session, asks, closes.
 *
 * A session per request rather than a held-open one, for now: the browser spawns a fresh proxy
 * anyway, and a long-lived port would need reconnect handling for a link that is idle most of
 * the time. */
export async function askDesktop(request: Record<string, unknown>, via?: string): Promise<any> {
	const source = await linkSource();
	if (!source) throw new Error("Not linked to the desktop app.");

	// Ride the held link when sync has one open. A second connection would displace it as the
	// target for the app's pushes, and closing this short-lived one would take that queue with
	// it, so sync would go quiet with nothing reporting a fault.
	const link = await ensureHeld();
	if (link) return askOverHeld(link, request);

	const asked = askOverOwnPipe(source, request, via);
	oneOffRequests = Promise.allSettled([oneOffRequests, asked]);
	return asked;
}

/** One-off requests on pipes of their own, in flight: see connectHeld. */
let oneOffRequests: Promise<unknown> = Promise.resolve();

async function askOverOwnPipe(
	source: LinkSource,
	request: Record<string, unknown>,
	via?: string,
): Promise<any> {
	const state = source.state;
	// A pipe this worker can open, or one a page has lent it. The second case is not an edge:
	// everything the UI does immediately AFTER pairing runs on the worker that just paired, which
	// still has no binding of its own and will not until it restarts. Claiming the desktop's sync
	// invite is exactly that, and it is why a first pairing used to hand over the link and never
	// the vault. See docs/desktop-link-optional-permission.md.
	const start = (await offscreen("LINK_START_INITIATOR", {
		privateKey: state.privateKey,
		remotePublicKey: state.appPublicKey,
	})) as { sessionId: number; message: string };

	const session = await pipeFor(via);
	if (!session) {
		await offscreen("LINK_CLOSE", { sessionId: start.sessionId }).catch(() => {});
		throw new Error("This browser cannot reach the desktop app yet.");
	}
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
		const parsed = JSON.parse(plain);
		if (refusedBy(parsed) === UNLINKED) await forgetRefused(source);
		return parsed;
	} finally {
		await offscreen("LINK_CLOSE", { sessionId: start.sessionId }).catch(() => {});
		session.close();
	}
}

/**
 * One request over the held link, answered by routeInbound. One at a time: the app answers a
 * link's requests in order, and the link has one slot for the request waiting. Sync and a page
 * ask independently, and two in flight handed each other's answers back.
 */
function askOverHeld(link: HeldLink, request: Record<string, unknown>): Promise<any> {
	const turn = link.asking.then(() => askOnce(link, request));
	link.asking = turn.catch(() => {});
	return turn;
}

async function askOnce(link: HeldLink, request: Record<string, unknown>): Promise<unknown> {
	const answer = new Promise<unknown>((resolve, reject) => {
		// A dead pipe would otherwise leave this pending forever, and the caller is a fill the
		// user is waiting on.
		const timer = setTimeout(() => {
			link.answer = null;
			// The answer may still come, and would be taken for the next request's. Start over.
			if (held === link) void dropHeld();
			reject(new Error("The desktop app did not answer."));
		}, ASK_TIMEOUT_MS);
		link.answer = (value) => {
			clearTimeout(timer);
			resolve(value);
		};
	});
	await sealAndSend(link, request);
	return answer;
}

/**
 * Seal one frame and put it on the pipe, in turn with every other.
 *
 * Noise numbers its frames, so the app can only open them in the order they were sealed. Seals
 * are a round trip to the crypto host, and two in flight could come back and be sent out of
 * order, which the app reads as a broken session and drops. So they queue.
 */
function sealAndSend(link: HeldLink, message: Record<string, unknown>): Promise<void> {
	const run = link.outbound.then(async () => {
		const sealed = (await offscreen("LINK_SEAL", {
			sessionId: link.sessionId,
			plaintext: JSON.stringify(message),
		})) as string;
		link.session.send({ sealed });
	});
	link.outbound = run.catch(() => {});
	return run;
}

/** Reconnect over KK, which is what every session after the first one does. */
export async function connectToDesktop(): Promise<boolean> {
	const state = await currentLink();
	if (!state) return false;
	if (!(await canOpenNativePipe())) return false;

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
	session: LinkTransport;
	/** The vault whose link this speaks; null for a link in progress. */
	vaultId: string | null;
	/** It speaks the single link an earlier build kept, not a vault's own. */
	legacy: boolean;
	/** The Noise session id, held in the offscreen where the crypto lives. */
	sessionId: number;
	/** Opens arrive in order and must be DECRYPTED in order: Noise numbers its transport frames,
	 * so two opens in flight at once can complete out of order and fail. */
	inbound: Promise<void>;
	/** The same for seals, outbound. See sealAndSend. */
	outbound: Promise<void>;
	/** The app said it speaks files, so file frames may go over this link. */
	files: boolean;
	/** Requests queue here, one at a time. See askOverHeld. */
	asking: Promise<unknown>;
	/** The request waiting for its answer, if any. */
	answer: ((value: unknown) => void) | null;
}

let held: HeldLink | null = null;
/** The connect under way, shared, so two callers cannot each open a pipe. A second connection
 * displaces the first as the target of the app's pushes; see HeldLink. */
let connecting: Promise<HeldLink | null> | null = null;

/** The capability that carries attachment bytes. Must match CAP_FILES in socket.rs. */
const CAP_FILES = "files";

/** Where the app's file frames and pokes go. Set while sync is running. */
let onBlobFrame: ((stream: number, frame: string) => void) | null = null;
let onBlobPoke: (() => void) | null = null;

/** Where a frame from the app goes. Set while sync is running. */
let onSyncFrame: ((frame: string, room?: string) => void) | null = null;
/** Where the vault copy's frames go. Set once at startup: a first-run join has no sync running. */
let onEnrollFrame: ((frame: string) => void) | null = null;

export function setEnrollFrameSink(sink: (frame: string) => void): void {
	onEnrollFrame = sink;
}

/**
 * Whether this browser should be holding the pipe open at all.
 *
 * Separate from sync, which is what it used to be tied to. The link carries autofill delegation
 * and the panel's fill requests too, so a browser that is paired and unlocked should be reachable
 * whether or not sync happens to be running — otherwise a vault that is not in a sync group has a
 * paired desktop app it can never be asked anything by.
 */
let linkWanted = false;

/** One credential the app is asking this browser to fill. Not stored anywhere. */
export interface DesktopFill {
	username: string;
	password: string;
	/**
	 * The authenticator KEY, not a code: the app has no TOTP implementation and sends what its
	 * index holds. Named for what it is, because filling it as though it were a code would put
	 * the seed on the page. The fill side computes the digits.
	 */
	totpKey?: string | null;
}

/** Where a fill the app asked for goes. Set by the autofill side. */
let onFillRequest: ((fill: DesktopFill) => void) | null = null;

/** A fill as the app frames it. Its `totp` is the authenticator key. */
interface WireFill {
	username?: string;
	password?: string;
	totp?: string | null;
}

/** Register the handler for a fill the desktop panel asked for. */
export function onDesktopFillRequest(handler: (fill: DesktopFill) => void): void {
	onFillRequest = handler;
}

/**
 * Tell the app which page this browser is on, so its panel can say where a fill would land.
 *
 * Only while a link is already held: this must not be the thing that spawns a native host, or
 * every tab switch would start a process on a machine with no desktop app running.
 */
/** Whether a link is live, so callers can skip work that only matters when one is. */
export function linkIsHeld(): boolean {
	return held !== null && !held.session.dead;
}

/** The vault whose link is held (null for one in progress); undefined when none is. */
export function heldVault(): string | null | undefined {
	return held && !held.session.dead ? held.vaultId : undefined;
}

export async function reportActiveTab(hostname: string): Promise<void> {
	const link = held;
	if (!link || link.session.dead) return;
	try {
		await sealAndSend(link, { op: "activeTab", hostname });
	} catch {
		// A dead pipe is not worth reporting: the next keepalive rebuilds it.
	}
}

/**
 * How often to re-establish the pipe while sync is running.
 *
 * The link has to be rebuilt by THIS side, and it is what tells the app a browser exists at all.
 * The app cannot reach out first: it learns of a browser only when one connects. So without this,
 * a desktop app that restarts (or starts after the browser did) is never spoken to again, and
 * both ends sit waiting for the other — the browser for a frame, the app for a connection.
 *
 * Cheap: a live link returns immediately, and there is nothing to do when no app is paired.
 */
const LINK_KEEPALIVE_MS = 20_000;

let keepalive: ReturnType<typeof setInterval> | undefined;

/**
 * Hold the pipe open because this browser is paired, whatever the lock state.
 *
 * Idempotent, and cheap when no app is paired: there is nothing to connect to, so it returns
 * false and the keepalive finds the same thing until one appears.
 */
export async function openDesktopLink(): Promise<boolean> {
	// Nothing to connect to. Checked BEFORE arming anything: almost nobody has a desktop app
	// paired, and an unconditional keepalive woke every one of those service workers every twenty
	// seconds, forever, to discover the same thing each time.
	if (!(await currentLink())) {
		await disarmWake();
		return false;
	}
	// Paired but unreachable from here: the permission was revoked, or this worker predates the
	// grant. Arming the keepalive would poll a pipe this context can never open. The next worker
	// start calls this again, which is what recovers it.
	if (!(await canOpenNativePipe())) {
		// Carried by a page's pipe: up, whatever this worker could open. Only losing it needs the next.
		if (held && !held.session.dead) return true;
		await awaitNextWorker();
		return false;
	}
	await disarmWake();
	linkWanted = true;
	startKeepalive();
	const up = (await ensureHeld()) !== null;
	if (up) console.log("[bramble:link] connected to the desktop app");
	return up;
}

/** Stop holding it: the vault locked, or the app was unlinked. */
export async function closeDesktopLink(): Promise<void> {
	linkWanted = false;
	await closeSyncLink();
}

function startKeepalive(): void {
	if (!keepalive) {
		keepalive = setInterval(() => {
			void ensureHeld().catch(() => {});
		}, LINK_KEEPALIVE_MS);
	}
}

function stopKeepalive(): void {
	if (keepalive) {
		clearInterval(keepalive);
		keepalive = undefined;
	}
}

/** Fires only to wake a worker: its start is what opens the link. */
const LINK_WAKE_ALARM = "desktop-link-wake";
/** Past the 30 to 60 s Chromium takes to stop an idle worker. Any sooner and the fire could only
 * wake this worker again and put that off. */
const LINK_WAKE_MINUTES = 1.05;
/** Once per worker: creating it again would keep putting off its next fire. */
let wakeArmed = false;

/** Nothing is left for a later worker to do. A wake left set would start one every minute. */
async function disarmWake(): Promise<void> {
	wakeArmed = false;
	await api.alarms.clear(LINK_WAKE_ALARM);
}

/**
 * This worker cannot open a pipe, and if it predates the grant, its successor can. Chromium replaces
 * a worker only once it has gone idle, and any API call resets that timer, so polling from here is
 * what would keep the link down for good. Stop, and leave an alarm to wake the next one: an app
 * cannot reach a browser that holds no pipe, so nothing else is sure to. A permission the user took
 * away needs no alarm, since no later worker can do better until it is back.
 */
async function awaitNextWorker(): Promise<void> {
	stopKeepalive();
	if (typeof api.runtime.connectNative === "function" || !(await permitted())) {
		await disarmWake();
		return;
	}
	// Sync drops the app now, rather than asking this worker for the vault until it times out.
	if (onSyncFrame) void offscreen("LINK_DOWN").catch(() => {});
	// A page that is open can carry the link until then.
	void api.runtime.sendMessage({ type: "DESKTOP_LINK_PIPE_LOST" }).catch(() => {});
	if (wakeArmed) return;
	wakeArmed = true;
	await api.alarms.create(LINK_WAKE_ALARM, {
		delayInMinutes: LINK_WAKE_MINUTES,
		periodInMinutes: LINK_WAKE_MINUTES,
	});
}

/** Whether a page lending a pipe would bring the link up: this worker cannot open one, and holds
 * none. Never true for a worker that can, so a page lends nothing to displace its connection. */
export async function pipeWanted(): Promise<boolean> {
	if (typeof api.runtime.connectNative === "function") return false;
	if (inProgress || (held && !held.session.dead)) return false;
	if (!(await currentLink())) return false;
	return permitted();
}

/** Hold the link over the pipe a page lent, for as long as that page is open. */
export async function holdOverLentPipe(via: string): Promise<boolean> {
	linkWanted = true;
	return (await ensureHeld(via)) !== null;
}

/** Route the app's sync frames to `onFrame`, and make sure the pipe is up to carry them. */
export async function openSyncLink(
	onFrame: (frame: string, room?: string) => void,
): Promise<boolean> {
	// A link held before sync wanted it (opened to link, before there was a vault) was offered
	// for sync and refused while nothing here answered. Ask the app to offer again on it: a worker
	// granted the permission this session cannot open another. An app from before that answers
	// with an error, and offers again only on a new connection, so the link starts afresh.
	const stale = onSyncFrame === null ? held : null;
	onSyncFrame = onFrame;
	if (stale && !stale.session.dead) {
		const offered = await askOverHeld(stale, { op: "syncRestart" })
			.then((answer) => answer?.ok === true)
			.catch(() => false);
		if (!offered && held === stale) await dropHeld();
	} else if (stale) {
		await dropHeld();
	}
	return openDesktopLink();
}

/** Stop routing sync frames. The pipe stays up if anything else still wants it. */
export async function closeSyncLink(): Promise<void> {
	onSyncFrame = null;
	if (linkWanted) return; // delegation and panel fills still need it
	stopKeepalive();
	const link = held;
	held = null;
	if (!link) return;
	await offscreen("LINK_CLOSE", { sessionId: link.sessionId }).catch(() => {});
	link.session.close();
}

/** Hand one sync frame to the app. False when the link is down, which is not an error: the
 * desktop app may simply not be running, and sync carries on over the relay. */
export async function sendSyncFrame(frame: string, room?: string): Promise<boolean> {
	return pushFrame(await ensureHeld(), { op: "sync", frame, ...(room ? { room } : {}) });
}

/** Push one unanswered frame. False with no link, or when the send fails, which drops the link
 * for the keepalive to rebuild. */
async function pushFrame(
	link: HeldLink | null,
	message: Record<string, unknown>,
): Promise<boolean> {
	if (!link) return false;
	try {
		await sealAndSend(link, message);
		return true;
	} catch {
		await dropHeld();
		return false;
	}
}

/** Route the app's file frames and pokes while sync runs. The pipe is sync's; see openSyncLink. */
export function openBlobLink(
	onFrame: (stream: number, frame: string) => void,
	onPoke: () => void,
): void {
	onBlobFrame = onFrame;
	onBlobPoke = onPoke;
}

export function closeBlobLink(): void {
	onBlobFrame = null;
	onBlobPoke = null;
}

/** Whether a link is up to an app that speaks files. Never opens one: the keepalive does. */
export function blobLinkUp(): boolean {
	return held !== null && !held.session.dead && held.files;
}

/** Hand one file frame to the app. False when there is no link to an app that speaks files,
 * which is ordinary: the app may be old, or not running. */
export async function sendBlobFrame(stream: number, frame: string): Promise<boolean> {
	return pushFrame(blobLinkUp() ? held : null, { op: "blob", stream, frame });
}

/** The held link, opening one if sync is running and there is none, over `via` if a page lent it. */
async function ensureHeld(via?: string): Promise<HeldLink | null> {
	if (held && !held.session.dead) return held;
	// A connect begun for another link drops itself; this one is for the link wanted now.
	if (!connecting || connectingGen !== linkGen) {
		connectingGen = linkGen;
		const attempt = connectHeld(via).finally(() => {
			if (connecting === attempt) connecting = null;
		});
		connecting = attempt;
	}
	return connecting;
}

let connectingGen = -1;

async function connectHeld(via?: string): Promise<HeldLink | null> {
	if (held) await dropHeld();
	if (!linkWanted) return null; // nothing wants the pipe held open
	// The app keys a browser's pushes by its static key: a request on a pipe of its own connecting
	// after this link would take them, and closing would leave this link receiving nothing.
	await Promise.race([
		oneOffRequests,
		new Promise((resolve) => setTimeout(resolve, ASK_TIMEOUT_MS)),
	]);

	const gen = linkGen;
	const source = await linkSource();
	// Not paired. The ordinary case, and openDesktopLink already declined to arm anything, so this
	// is only reachable if a pairing was removed while the keepalive was live. Not worth a line.
	if (!source) return null;
	const state = source.state;
	// Revoked while the keepalive was live, or the page lending this worker a pipe has gone. Without
	// this a new NativeSession calls an undefined connectNative and throws a TypeError into whatever
	// happened to be awaiting.
	const session = await pipeFor(via);
	if (!session) {
		await awaitNextWorker();
		return null;
	}
	const start = (await offscreen("LINK_START_INITIATOR", {
		privateKey: state.privateKey,
		remotePublicKey: state.appPublicKey,
	})) as { sessionId: number; message: string };

	// Inbound frames wait on this: the app may push before this side has read the handshake's last
	// message, and a frame dropped then leaves Noise out of step for the life of the link.
	let transportReady!: () => void;
	const link: HeldLink = {
		session,
		vaultId: source.vaultId,
		legacy: source.legacy,
		sessionId: start.sessionId,
		inbound: new Promise<void>((resolve) => {
			transportReady = resolve;
		}),
		outbound: Promise.resolve(),
		files: false,
		asking: Promise.resolve(),
		answer: null,
	};
	session.intercept((msg) => {
		if (typeof msg?.sealed !== "string") return false;
		// Claimed BEFORE it is opened, and opened on a chain, because deciding what a frame is
		// requires decrypting it and decryption has to happen in arrival order.
		link.inbound = link.inbound.then(() => routeInbound(link, msg.sealed as string));
		return true;
	});
	try {
		session.send({ kind: "hello", v: PROTOCOL_VERSION, publicKey: state.publicKey });
		const reply = await session.request({ message: start.message });
		if (reply?.ok !== true || reply?.done !== true) throw new Error("refused");
		// KK is two messages; feeding the reply back is what puts this side in transport mode.
		if (reply.message) {
			await offscreen("LINK_READ", { sessionId: start.sessionId, message: reply.message });
		}
	} catch (e) {
		console.warn("[bramble:link] desktop app refused or unreachable:", e);
		await offscreen("LINK_CLOSE", { sessionId: start.sessionId }).catch(() => {});
		session.close();
		return null;
	}
	transportReady();
	session.onDead(() => {
		// Only if it is still the current link: a rebuild may already have replaced it.
		const wasHeld = held === link;
		if (wasHeld) held = null;
		// Closed with the page that lent it: ask another, or wait for the next worker.
		if (wasHeld && session instanceof ProxiedSession) void ensureHeld().catch(() => {});
	});
	// What the app speaks, asked before the link is published so no other request can race the
	// answer. An app from before caps answers with an error, and gets no file frames.
	const caps = await askOverHeld(link, { op: "caps", caps: [CAP_FILES] }).catch(() => null);
	// The app seals its refusal as the session's first frame, which proves it is the app this
	// browser paired with: only then may it make the browser drop a link.
	const refused = refusedBy(caps);
	// Which link should be held may have changed while this connected; if so, let it go.
	if (refused || gen !== linkGen) {
		if (refused === UNLINKED) await forgetRefused(link);
		await offscreen("LINK_CLOSE", { sessionId: start.sessionId }).catch(() => {});
		session.close();
		return null;
	}
	link.files = Array.isArray(caps?.caps) && caps.caps.includes(CAP_FILES);
	held = link;
	if (source.legacy) void adoptLegacyLink(link);
	return link;
}

/** What the app sends: a pushed frame of one kind, or the answer to a request. */
interface InboundFrame {
	sync?: string;
	fill?: WireFill;
	blob?: string;
	stream?: number;
	blobPoke?: boolean;
	[answer: string]: unknown;
}

/** Open one inbound frame and dispatch it: a sync frame to sync, anything else to the request
 * waiting for it. */
async function routeInbound(link: HeldLink, sealed: string): Promise<void> {
	let parsed: InboundFrame;
	try {
		const plain = (await offscreen("LINK_OPEN", {
			sessionId: link.sessionId,
			sealed,
		})) as string;
		parsed = JSON.parse(plain) as InboundFrame;
	} catch {
		// An unopenable frame means this session is out of step; rebuilding is the only recovery.
		// Whoever is waiting hears it now rather than at a timeout.
		link.answer?.({ ok: false, error: "unreadable frame" });
		link.answer = null;
		if (held === link) await dropHeld();
		return;
	}
	if (typeof parsed.sync === "string" && parsed.room === "enroll") {
		onEnrollFrame?.(parsed.sync);
		return;
	}
	if (typeof parsed.sync === "string") {
		onSyncFrame?.(parsed.sync, typeof parsed.room === "string" ? parsed.room : undefined);
		return;
	}
	if (typeof parsed.blob === "string" && typeof parsed.stream === "number") {
		onBlobFrame?.(parsed.stream, parsed.blob);
		return;
	}
	if (parsed.blobPoke === true) {
		onBlobPoke?.();
		return;
	}
	if (parsed.fill && typeof parsed.fill.password === "string") {
		onFillRequest?.({
			username: parsed.fill.username ?? "",
			password: parsed.fill.password,
			// `totp` on the wire, and a key rather than a code; see DesktopFill.
			totpKey: parsed.fill.totp ?? null,
		});
		return;
	}
	if (refusedBy(parsed) === UNLINKED) void forgetRefused(link);
	// An answer: hand the plaintext to whoever asked. Requests over the held link resolve here.
	link.answer?.(parsed);
	link.answer = null;
}

/** Make a new link the one in progress, and let go of any held one: it speaks as another key,
 * and the app binds its invite to the key that just linked. */
async function holdInProgress(state: LinkState, listed = false): Promise<LinkState> {
	inProgress = { state, listed };
	linkGen++;
	await dropHeld();
	return state;
}

/**
 * Attach the link in progress to the vault that now holds the desktop's, once the app has listed
 * it. False, with the link let go, when the app will not complete it (its window closed, or the
 * link expired) or there is none in progress (a worker restarted mid-copy).
 */
export async function attachLink(vaultId: string): Promise<boolean> {
	if (!inProgress) return false;
	const { state, listed } = inProgress;
	if (listed) {
		await settle(vaultId, state);
		return true;
	}
	const link = held?.vaultId === null ? held : await ensureHeld();
	const answer = link
		? ((await askOverHeld(link, { op: "linkComplete" }).catch(() => null)) as {
				ok?: boolean;
				error?: unknown;
			} | null)
		: null;
	// An app from before this lists a browser when it links, and does not know the request.
	const older = typeof answer?.error === "string" && answer.error.startsWith("bad request");
	if (answer?.ok !== true && !older) {
		await abandonLink();
		return false;
	}
	await settle(vaultId, state);
	return true;
}

/** The link in progress is now `vaultId`'s. Held only while that vault is open: the flow may have
 * ended with another one open, whose own link is the one to hold. */
async function settle(vaultId: string, state: LinkState): Promise<void> {
	inProgress = null;
	linkGen++;
	await api.storage.local.set({ [linkKeyFor(vaultId)]: state });
	if (held?.vaultId === null) held.vaultId = vaultId;
	if (held && held.vaultId !== getActiveVaultId()) await dropHeld();
	void openDesktopLink().catch(() => {});
}

/** Let go of the link in progress: its flow ended without a vault. Nothing is stored. The app
 * forgets its half when the pipe the link was confirmed on closes. */
export async function abandonLink(): Promise<void> {
	if (!inProgress) return;
	inProgress = null;
	linkGen++;
	if (held?.vaultId === null) await dropHeld();
	void openDesktopLink().catch(() => {});
}

/** The open vault changed: hold its link, not another's. A link in progress stays, because its
 * vault copy changes the open vault itself. None open (a lock) keeps the one held: it is the vault
 * the browser would unlock into. Run after the transition rather than inside it, so the
 * transition's own reads come first. */
export function retargetLink(vaultId: string | null): void {
	queueMicrotask(() => {
		if (inProgress) return;
		linkGen++;
		if (held && vaultId !== null && held.vaultId !== vaultId) void dropHeld();
		void openDesktopLink().catch(() => {});
	});
}

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

/** Disconnect one vault's link, and say how many vaults still have one: the browser permission
 * goes back only with the last. */
export async function unlinkDesktop(vaultId: string): Promise<{ remaining: number }> {
	const source = await vaultLink(vaultId);
	if (source) await removeLink(source.legacy ? STORAGE_KEY : linkKeyFor(vaultId));
	const reg = parseRegistry(await extensionStorage.getMeta(VAULT_REGISTRY_KEY).catch(() => null));
	const keys = [...reg.vaults.map((v) => linkKeyFor(v.id)), STORAGE_KEY];
	const left = await Promise.all(keys.map((k) => loadLink(k)));
	return { remaining: left.filter(Boolean).length };
}

export async function desktopLinkStatus(): Promise<{
	paired: boolean;
	pairedAt?: number;
	permitted: boolean;
}> {
	// The vault's own link: one still in progress is not linked yet.
	const state = (await vaultLink(await linkVault()))?.state ?? null;
	// The permission, not this worker's ability to use it. The UI is asking "did the user take
	// this away", which stays true across a worker that simply started too early.
	const allowed = await permitted();
	return state
		? { paired: true, pairedAt: state.pairedAt, permitted: allowed }
		: { paired: false, permitted: allowed };
}

// Revoked in chrome://extensions while paired. Stop holding a pipe the browser will now refuse,
// rather than leaving the keepalive to rediscover it every twenty seconds.
//
// There is deliberately NO matching onAdded handler. It would run in THIS worker, which cannot
// have gained the binding (see canOpenNativePipe), so it could only fail. The link comes up when
// the worker next starts. Adding one looks obviously right and is the trap this comment exists to
// prevent; see docs/desktop-link-optional-permission.md.
api.permissions?.onRemoved?.addListener((removed) => {
	if (!removed.permissions?.includes("nativeMessaging")) return;
	void closeDesktopLink().catch(() => {});
});

on(
	"DESKTOP_LINK_CLAIM_INVITE",
	// Ask the app for the sync invite it armed. The app answers only while its dialog is open, so
	// a refusal here is the ordinary case and not something to surface as a failure.
	extensionOnly(async (message) => {
		try {
			const answer = (await askDesktop({ op: "syncInvite" }, viaOf(message))) as {
				ok?: boolean;
				invite?: string;
			};
			return { ok: true, data: answer?.ok === true ? (answer.invite ?? null) : null };
		} catch {
			return { ok: true, data: null };
		}
	}),
);

/** What the app's vault holds, for deciding what linking does. Null when it will not say: not
 * the browser that just linked, the app is locked, or it predates this. */
export async function desktopVaultSummary(via?: string): Promise<{
	name: string;
	empty: boolean;
	entries: number;
} | null> {
	try {
		const answer = (await askDesktop({ op: "vaultSummary" }, via)) as {
			ok?: boolean;
			summary?: { name: string; empty: boolean; entries: number };
		};
		return answer?.ok === true ? (answer.summary ?? null) : null;
	} catch {
		return null;
	}
}

on(
	"DESKTOP_LINK_VAULT_SUMMARY",
	extensionOnly(async (message) => ({ ok: true, data: await desktopVaultSummary(viaOf(message)) })),
);

/** The app's sync device key, or null when it is not linked or not running. */
export async function desktopSyncKey(via?: string): Promise<string | null> {
	const link = await currentLink();
	if (!link) return null;
	const key = appSyncKeyFor(link);
	try {
		const answer = (await askDesktop({ op: "syncIdentity" }, via)) as {
			ok?: boolean;
			identity?: string;
		};
		if (answer?.ok === true && answer.identity) {
			await api.storage.local.set({ [key]: answer.identity });
			return answer.identity;
		}
	} catch {
		// The pipe is down, which is when the relay most needs to tell the app apart.
	}
	const known = (await api.storage.local.get(key))[key];
	return typeof known === "string" ? known : null;
}

on(
	"DESKTOP_LINK_SYNC_KEY",
	// The app's own sync key, as last heard when it is not running. Null rather than an error when
	// it never said: the UI says less in that case rather than claiming something it cannot check.
	extensionOnly(async (message) => ({ ok: true, data: await desktopSyncKey(viaOf(message)) })),
);

on(
	"LINK_SYNC_SEND",
	// The offscreen runs sync but the port lives here, so its outbound frames come through this.
	// False rather than an error when the link is down: the app may simply not be running, and
	// sync carries on over the relay.
	extensionOnly(async (message) => {
		const { frame, room } = (message.payload ?? {}) as { frame?: unknown; room?: unknown };
		if (typeof frame !== "string") return { ok: false, error: "LINK_SYNC_SEND requires a frame" };
		return {
			ok: true,
			data: await sendSyncFrame(frame, typeof room === "string" ? room : undefined),
		};
	}),
);

on(
	"LINK_BLOB_SEND",
	// The offscreen's file session, the same way. False when no link to an app that speaks files.
	extensionOnly(async (message) => {
		const { stream, frame } = (message.payload ?? {}) as { stream?: unknown; frame?: unknown };
		if (typeof stream !== "number" || typeof frame !== "string") {
			return { ok: false, error: "LINK_BLOB_SEND requires a stream and a frame" };
		}
		return { ok: true, data: await sendBlobFrame(stream, frame) };
	}),
);

on(
	"LINK_BLOB_UP",
	extensionOnly(async () => ({ ok: true, data: blobLinkUp() })),
);

on(
	"DESKTOP_LINK_START",
	extensionOnly(async (message) => ({ ok: true, data: await startDesktopLink(viaOf(message)) })),
);

on(
	"DESKTOP_LINK_CANCEL",
	extensionOnly(async (message) => {
		const { id } = message as { id?: unknown };
		if (typeof id === "string") await cancelDesktopLink(id);
		return { ok: true };
	}),
);

on(
	"DESKTOP_LINK_CONFIRM",
	extensionOnly(async (message) => {
		const { id, matches } = message as { id?: unknown; matches?: unknown };
		if (typeof id !== "string") return { ok: false, error: "no link id" };
		const state = await confirmDesktopLink(id, matches === true);
		// As after a code pairing: the link is usable from this moment.
		void openDesktopLink().catch(() => {});
		return { ok: true, data: { publicKey: state.publicKey, pairedAt: state.pairedAt } };
	}),
);

on(
	"DESKTOP_LINK_PAIR",
	extensionOnly(async (message) => {
		const code = String((message as { code?: unknown }).code ?? "");
		if (!code) return { ok: false, error: "no code" };
		const state = await pairWithDesktop(code, viaOf(message));
		// A link is possible from this moment; without this it would wait for a browser restart,
		// since openDesktopLink now declines to arm anything for an unpaired browser.
		void openDesktopLink().catch(() => {});
		return { ok: true, data: { publicKey: state.publicKey, pairedAt: state.pairedAt } };
	}),
);

on(
	"DESKTOP_LINK_CONNECT",
	extensionOnly(async () => ({ ok: true, data: await connectToDesktop() })),
);

/**
 * Whether this worker needs a page to lend it a native pipe, because it cannot open one itself.
 *
 * The page asks BEFORE lending rather than always lending, and the reason is not thrift. The app
 * keys its outbound queue by our static key, so a second connection displaces the first as the
 * target for its pushes and closing the second takes that queue with it: sync would go quiet with
 * nothing reporting a fault. Lending is only safe when there is nothing to displace.
 */
export async function transportNeeded(): Promise<boolean> {
	return !(await canOpenNativePipe());
}

on(
	"DESKTOP_LINK_TRANSPORT_NEEDED",
	extensionOnly(async () => ({ ok: true, data: await transportNeeded() })),
);

on(
	"DESKTOP_LINK_PIPE_WANTED",
	extensionOnly(async () => ({ ok: true, data: await pipeWanted() })),
);

on(
	"DESKTOP_LINK_LEND_PIPE",
	extensionOnly(async (message) => {
		const via = viaOf(message);
		return { ok: true, data: via === undefined ? false : await holdOverLentPipe(via) };
	}),
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
	// The open vault's link, and no other vault's.
	extensionOnly(async () => {
		const vaultId = getActiveVaultId();
		if (!vaultId) return { ok: false, error: "no vault is open" };
		const left = await unlinkDesktop(vaultId);
		// Nothing left to authenticate with, so stop holding a pipe the app would refuse anyway.
		await closeDesktopLink();
		return { ok: true, data: left };
	}),
);

on(
	"DESKTOP_LINK_ATTACH",
	// The flow ended with this vault holding the desktop's: the pairing is complete.
	extensionOnly(async (message) => {
		const { vaultId } = message as { vaultId?: unknown };
		if (typeof vaultId !== "string") return { ok: false, error: "no vault id" };
		return { ok: true, data: await attachLink(vaultId) };
	}),
);

/** A deleted vault's link goes with it: the desktop app would still accept the key. */
export async function forgetVaultLink(vaultId: string): Promise<void> {
	await removeLink(linkKeyFor(vaultId));
	if (held?.vaultId === vaultId) await dropHeld();
}

on(
	"DESKTOP_LINK_FORGET_VAULT",
	extensionOnly(async (message) => {
		const { vaultId } = message as { vaultId?: unknown };
		if (typeof vaultId === "string") await forgetVaultLink(vaultId);
		return { ok: true };
	}),
);

on(
	"DESKTOP_LINK_PROVEN",
	// From the offscreen sync host: the app passed the roster check over the link for this vault.
	extensionOnly(async (message) => {
		const { vaultId } = message as { vaultId?: unknown };
		if (typeof vaultId === "string") await desktopLinkProven(vaultId);
		return { ok: true };
	}),
);

on(
	"DESKTOP_LINK_ABANDON",
	extensionOnly(async () => {
		await abandonLink();
		return { ok: true };
	}),
);
