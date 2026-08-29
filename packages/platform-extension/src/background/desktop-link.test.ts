import { beforeEach, describe, expect, it, vi } from "vitest";

// The held-open link to the desktop app, which sync needs and delegation did not.
//
// Two properties are load-bearing and neither is visible from a happy-path fill. First, a frame
// the app pushes must never be handed back as the answer to an outstanding request: the session
// would be one frame out of step for the rest of its life, and every later fill would return the
// previous fill's credential. Second, there must be at most ONE connection from this extension,
// because the app keys its outbound queue by our static key and a second connection displaces
// the first as the target for pushes.

const h = vi.hoisted(() => ({
	/** Frames posted to the native host, in order. */
	posted: [] as Record<string, unknown>[],
	/** Handlers registered on the live port. */
	onMessage: [] as ((msg: unknown) => void)[],
	onDisconnect: [] as (() => void)[],
	/** Listeners registered on runtime.onConnect, so a test can hand in a proxy port. */
	onConnect: [] as ((port: unknown) => void)[],
	/** Whether the user has granted nativeMessaging. */
	permitted: true,
	/**
	 * Whether THIS context was handed the connectNative binding. Independent of `permitted` on
	 * purpose: a worker that was already running when the grant happened has one and not the other,
	 * and that combination is the entire reason the gating exists.
	 */
	hasBinding: true,
	onPermissionRemoved: [] as ((p: { permissions?: string[] }) => void)[],
	/** How many native ports have been opened; the count IS the connection count. */
	connects: 0,
	disconnects: 0,
	/** Plaintext, keyed by the sealed blob standing in for it. Sealing here is a rename. */
	sealed: new Map<string, string>(),
	stored: {} as Record<string, unknown>,
}));

/** The native port chrome.runtime.connectNative hands back. */
const nativePort = () => {
	h.connects++;
	return {
		postMessage: (msg: Record<string, unknown>) => {
			h.posted.push(msg);
		},
		onMessage: { addListener: (cb: (msg: unknown) => void) => h.onMessage.push(cb) },
		onDisconnect: { addListener: (cb: () => void) => h.onDisconnect.push(cb) },
		disconnect: () => {
			h.disconnects++;
		},
	};
};

vi.mock("../platform-api", () => ({
	api: {
		runtime: {
			// A getter, so a test can model the context that HAS the permission and still has no
			// API to call, which is what a worker that predates the grant looks like.
			get connectNative() {
				return h.hasBinding ? nativePort : undefined;
			},
			lastError: undefined,
			// The module now guards its proxy port with isExtensionSender, which resolves the
			// extension origin at import time. An https stand-in, not a real chrome-extension://
			// URL: Node gives non-special schemes an opaque "null" origin, which would reject
			// every port including the legitimate ones. Same trick as sender.test.ts.
			id: "bramble-test",
			getURL: (p: string) => `https://bramble-test.example/${p}`,
			onConnect: {
				addListener: (cb: (port: unknown) => void) => h.onConnect.push(cb),
			},
		},
		permissions: {
			contains: async () => h.permitted,
			onRemoved: {
				addListener: (cb: (p: { permissions?: string[] }) => void) =>
					h.onPermissionRemoved.push(cb),
			},
		},
		storage: {
			local: {
				get: async (key: string) => ({ [key]: h.stored[key] }),
				set: async () => {},
				remove: async () => {},
			},
		},
	},
}));

// The crypto lives in the offscreen document. Sealing is modelled as a reversible rename, so the
// tests exercise routing rather than Noise.
vi.mock("./offscreen-client", () => ({
	sendToOffscreen: async (msg: { type: string; payload?: Record<string, unknown> }) => {
		switch (msg.type) {
			case "LINK_START_INITIATOR":
				return { ok: true, data: { sessionId: 7, message: "kk1" } };
			// Pairing (XXpsk3) rather than reconnect (KK). Only the pairing tests reach these.
			case "SYNC_GENERATE_KEYPAIR":
				return { ok: true, data: { privateKey: "priv", publicKey: "pub" } };
			case "LINK_ENROLL_INITIATOR":
				return { ok: true, data: { sessionId: 9, message: "xx1" } };
			case "LINK_REMOTE_STATIC":
				return { ok: true, data: "app-pub" };
			// The KK path ignores this; the pairing path reads `message` off it.
			case "LINK_READ":
				return { ok: true, data: { message: "xx3", done: false } };
			case "LINK_SEAL": {
				const plaintext = msg.payload?.plaintext as string;
				const blob = `sealed:${plaintext}`;
				h.sealed.set(blob, plaintext);
				return { ok: true, data: blob };
			}
			case "LINK_OPEN": {
				const blob = msg.payload?.sealed as string;
				const plain = h.sealed.get(blob) ?? blob.replace(/^sealed:/, "");
				return { ok: true, data: plain };
			}
			case "LINK_CLOSE":
				return { ok: true, data: undefined };
			default:
				return { ok: false, error: `unexpected ${msg.type}` };
		}
	},
}));

vi.mock("./router", () => ({
	on: () => {},
	extensionOnly: (fn: unknown) => fn,
}));

/** Deliver a frame from the app, as the native port would. */
const deliver = (msg: unknown) => {
	for (const cb of h.onMessage) cb(msg);
};

/** Answer the KK handshake so the held link finishes opening. */
const completeHandshake = () => deliver({ ok: true, done: true, message: "kk2" });

/** The app pushing a sync frame, unprompted. */
const pushSync = (frame: string) =>
	deliver({ sealed: `sealed:${JSON.stringify({ sync: frame })}` });

async function load() {
	vi.resetModules();
	h.posted.length = 0;
	h.onMessage.length = 0;
	h.onDisconnect.length = 0;
	h.onConnect.length = 0;
	h.onPermissionRemoved.length = 0;
	h.connects = 0;
	h.disconnects = 0;
	h.permitted = true;
	h.hasBinding = true;
	h.sealed.clear();
	h.stored = {
		desktopLink: {
			privateKey: "priv",
			publicKey: "pub",
			appPublicKey: "app-pub",
			pairedAt: 1,
		},
	};
	return import("./desktop-link");
}

/** Open the held link and settle its handshake. */
async function open(mod: Awaited<ReturnType<typeof load>>, frames: string[]) {
	const opening = mod.openSyncLink((f) => frames.push(f));
	await vi.waitFor(() => expect(h.onMessage.length).toBeGreaterThan(0));
	completeHandshake();
	expect(await opening).toBe(true);
}

beforeEach(() => {
	vi.useRealTimers();
});

describe("the held sync link", () => {
	it("routes a pushed frame to sync", async () => {
		const mod = await load();
		const frames: string[] = [];
		await open(mod, frames);

		pushSync("from-app");

		await vi.waitFor(() => expect(frames).toEqual(["from-app"]));
	});

	it("does not answer a request with a frame the app pushed", async () => {
		// The bug this exists for: the pushed frame arrives between the request and its answer.
		// Handed back as the answer, every later request would return the previous one's result.
		const mod = await load();
		const frames: string[] = [];
		await open(mod, frames);

		const asked = mod.askDesktop({ op: "query", hostname: "example.com" });
		await vi.waitFor(() => expect(h.posted.some((m) => "sealed" in m)).toBe(true));

		pushSync("interleaved");
		deliver({ sealed: `sealed:${JSON.stringify({ ok: true, matches: [] })}` });

		expect(await asked).toEqual({ ok: true, matches: [] });
		expect(frames).toEqual(["interleaved"]);
	});

	it("keeps one connection open rather than one per request", async () => {
		// A second connection displaces this one as the target for the app's pushes, and closing
		// it takes the queue with it: sync goes quiet with nothing reporting a fault.
		const mod = await load();
		const frames: string[] = [];
		await open(mod, frames);
		const afterOpen = h.connects;

		const asked = mod.askDesktop({ op: "query", hostname: "example.com" });
		await vi.waitFor(() => expect(h.posted.some((m) => "sealed" in m)).toBe(true));
		deliver({ sealed: `sealed:${JSON.stringify({ ok: true, matches: [] })}` });
		await asked;

		expect(h.connects).toBe(afterOpen);
		expect(h.disconnects).toBe(0);
	});

	it("sends a sync frame the app can read", async () => {
		const mod = await load();
		const frames: string[] = [];
		await open(mod, frames);
		h.posted.length = 0;

		expect(await mod.sendSyncFrame("outbound")).toBe(true);

		const sent = h.posted.at(-1) as { sealed: string };
		expect(JSON.parse(h.sealed.get(sent.sealed) ?? "")).toEqual({
			op: "sync",
			frame: "outbound",
		});
	});

	it("reports a closed link rather than throwing, because the app may just not be running", async () => {
		const mod = await load();
		// Never opened: sync is running but the desktop app is not.
		expect(await mod.sendSyncFrame("outbound")).toBe(false);
	});

	it("keeps the pipe when sync stops, because delegation still needs it", async () => {
		// The pipe used to be opened only as a side effect of sync, so a vault in no sync group
		// had a paired desktop app that could never ask it for anything — no autofill delegation
		// and no fill from the panel.
		const mod = await load();
		const frames: string[] = [];
		await open(mod, frames);

		await mod.closeSyncLink();

		expect(h.disconnects).toBe(0);
	});

	it("closes the pipe only when the app is unlinked", async () => {
		// NOT on lock. Filling while locked is the reason the link exists, so a locked browser has
		// to stay reachable; unlinking is what leaves nothing to authenticate with.
		const mod = await load();
		const frames: string[] = [];
		await open(mod, frames);

		await mod.closeDesktopLink();

		expect(h.disconnects).toBe(1);
		expect(await mod.sendSyncFrame("outbound")).toBe(false);
	});

	it("holds the pipe open for a browser that is unlocked but not syncing", async () => {
		const mod = await load();
		const opening = mod.openDesktopLink();
		await vi.waitFor(() => expect(h.onMessage.length).toBeGreaterThan(0));
		completeHandshake();

		expect(await opening).toBe(true);
		expect(h.connects).toBe(1);
	});

	it("gives up on a request the app never answers", async () => {
		// A dead pipe would otherwise leave a fill pending forever, with the user watching it.
		vi.useFakeTimers();
		const mod = await load();
		const frames: string[] = [];
		const opening = mod.openSyncLink((f) => frames.push(f));
		await vi.waitFor(() => expect(h.onMessage.length).toBeGreaterThan(0));
		completeHandshake();
		await opening;

		const asked = mod.askDesktop({ op: "query", hostname: "example.com" });
		const settled = expect(asked).rejects.toThrow(/did not answer/);
		await vi.advanceTimersByTimeAsync(11_000);
		await settled;
	});
});

describe("keeping the pipe up", () => {
	it("re-establishes the link after the app restarts", async () => {
		// The deadlock this exists to break: the app learns a browser exists only when one
		// CONNECTS, and the browser only speaks once the app has spoken. So after the app
		// restarts, nothing reconnects and both ends wait for the other forever.
		vi.useFakeTimers();
		const mod = await load();
		const frames: string[] = [];
		const opening = mod.openSyncLink((f) => frames.push(f));
		await vi.waitFor(() => expect(h.onMessage.length).toBeGreaterThan(0));
		completeHandshake();
		await opening;
		const afterOpen = h.connects;

		// The app goes away, taking the pipe with it.
		for (const cb of h.onDisconnect) cb();
		await vi.advanceTimersByTimeAsync(25_000);
		// The rebuilt link needs its handshake answered, as the first one did.
		completeHandshake();

		await vi.waitFor(() => expect(h.connects).toBeGreaterThan(afterOpen));
		vi.useRealTimers();
	});

	it("stops re-establishing once sync stops", async () => {
		// Otherwise stopping sync would leave a timer spawning native host processes forever.
		vi.useFakeTimers();
		const mod = await load();
		const opening = mod.openSyncLink(() => {});
		await vi.waitFor(() => expect(h.onMessage.length).toBeGreaterThan(0));
		completeHandshake();
		await opening;

		await mod.closeSyncLink();
		const afterClose = h.connects;
		await vi.advanceTimersByTimeAsync(120_000);

		expect(h.connects).toBe(afterClose);
		vi.useRealTimers();
	});
});

describe("a browser with no desktop app", () => {
	it("arms nothing at all", async () => {
		// This is nearly every install. An unconditional keepalive woke each of those service
		// workers every twenty seconds, forever, to rediscover that there is nothing to connect to.
		vi.useFakeTimers();
		const mod = await load();
		h.stored = {}; // never paired

		expect(await mod.openDesktopLink()).toBe(false);
		expect(h.connects).toBe(0);

		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(h.connects).toBe(0);
		vi.useRealTimers();
	});
});

// Pairing runs on a transport the PAGE opens, because the worker cannot open one. A worker that
// was already running when the user granted nativeMessaging never gains connectNative, and the
// open pairing window is itself what stops it restarting to pick the binding up. So the page
// lends a pipe and the handshake, the keys and the storage write all stay here.
describe("pairing borrows the page's native transport", () => {
	/** Hand the background a proxy port, as runtime.onConnect would. */
	function lend(sender: unknown) {
		const sent: Record<string, unknown>[] = [];
		let onMessage: ((m: unknown) => void) | undefined;
		let onDisconnect: (() => void) | undefined;
		let disconnected = false;
		const port = {
			name: "link-native-proxy",
			sender,
			postMessage: (m: Record<string, unknown>) => sent.push(m),
			onMessage: {
				addListener: (cb: (m: unknown) => void) => {
					onMessage = cb;
				},
			},
			onDisconnect: {
				addListener: (cb: () => void) => {
					onDisconnect = cb;
				},
			},
			disconnect: () => {
				disconnected = true;
			},
		};
		for (const cb of h.onConnect) cb(port);
		return {
			sent,
			get disconnected() {
				return disconnected;
			},
			/** A frame arriving from the desktop app, relayed by the page. */
			deliver: (frame: unknown) => onMessage?.({ frame }),
			/** The page reporting that its native port died. */
			die: (dead: string) => onMessage?.({ dead }),
			/** The pairing window closing. */
			drop: () => onDisconnect?.(),
		};
	}

	/** A popup or pop-out: the extension origin. See the getURL note on the platform-api mock. */
	const EXT_SENDER = { origin: "https://bramble-test.example" };

	/** Drive a pairing to completion over `page`, resolving what pairWithDesktop returned. */
	async function pairOver(
		mod: { pairWithDesktop: (c: string) => Promise<unknown> },
		page: ReturnType<typeof lend>,
	) {
		const paired = mod.pairWithDesktop("ABCD1234");
		await vi.waitFor(() => expect(page.sent.length).toBe(3));
		page.deliver({ ok: true, message: "xx2" });
		await vi.waitFor(() => expect(page.sent.length).toBe(4));
		page.deliver({ done: true });
		return paired;
	}

	it("acks the port, so the page can pair without racing the connect", async () => {
		await load();

		expect(lend(EXT_SENDER).sent[0]).toEqual({ ready: true });
	});

	it("pairs over the lent port and never opens a native port of its own", async () => {
		const mod = await load();
		const page = lend(EXT_SENDER);

		await expect(pairOver(mod, page)).resolves.toMatchObject({
			publicKey: "pub",
			appPublicKey: "app-pub",
		});
		// The assertion the whole design rests on. A direct connectNative here would be the
		// undefined binding, i.e. a TypeError swallowed into a silently dead link.
		expect(h.connects).toBe(0);
		// Opaque frames only: the page relays what it is given and reads none of it.
		expect(page.sent[1]).toMatchObject({ frame: { kind: "pair" } });
		expect(page.sent[2]).toEqual({ frame: { message: "xx1" } });
	});

	it("refuses a port from a content script and does not pair over it", async () => {
		const mod = await load();
		const evil = lend({ origin: "https://evil.example", tab: { id: 1 } });

		expect(evil.disconnected).toBe(true);
		// Rejecting the port is only half of it; it must also never have become the transport.
		// Falling back to a direct session is what proves it did not.
		void mod.pairWithDesktop("ABCD1234").catch(() => {});
		await vi.waitFor(() => expect(h.connects).toBe(1));
		expect(evil.sent).toEqual([]);
	});

	it("fails the handshake when the pairing window closes mid-flight", async () => {
		const mod = await load();
		const page = lend(EXT_SENDER);

		const paired = mod.pairWithDesktop("ABCD1234");
		await vi.waitFor(() => expect(page.sent.length).toBe(3));
		page.drop();

		// Without this the pairing sits on a promise nothing will ever settle, and the UI spins.
		await expect(paired).rejects.toThrow(/pairing window closed/);
	});

	it("surfaces a native host the page could not reach", async () => {
		const mod = await load();
		const page = lend(EXT_SENDER);

		const paired = mod.pairWithDesktop("ABCD1234");
		await vi.waitFor(() => expect(page.sent.length).toBe(3));
		// The ordinary "desktop app is not installed" case: Chrome reports it as a bare
		// disconnect and the page forwards the reason.
		page.die("Specified native messaging host not found.");

		await expect(paired).rejects.toThrow(/not found/);
	});
});

// The permission is optional, so a paired browser can be unable to use its own link. Two distinct
// causes with the same symptom, and the difference matters: REVOKED is the user taking it away and
// is permanent until they give it back, while NO BINDING is this worker having started before the
// grant and repairs itself on the next start. Neither may reach connectNative, which is undefined
// in the second case and would throw a TypeError into whatever was awaiting.
describe("a paired browser that cannot use native messaging", () => {
	it("arms nothing when the permission was revoked", async () => {
		const mod = await load();
		h.permitted = false;

		expect(await mod.openDesktopLink()).toBe(false);
		expect(h.connects).toBe(0);
	});

	it("arms nothing when this worker predates the grant", async () => {
		// Permitted, and still no API to call. The combination that made the naive
		// permissions.onAdded design impossible.
		const mod = await load();
		h.hasBinding = false;

		expect(await mod.openDesktopLink()).toBe(false);
		expect(h.connects).toBe(0);
	});

	it("does not poll a pipe it can never open", async () => {
		vi.useFakeTimers();
		const mod = await load();
		h.permitted = false;
		await mod.openDesktopLink();

		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(h.connects).toBe(0);
		vi.useRealTimers();
	});

	it("refuses a delegated request in words rather than a TypeError", async () => {
		const mod = await load();
		h.hasBinding = false;

		// A fill the user is watching. "connectNative is not a function" in a console is not an
		// explanation of why their password did not appear.
		await expect(mod.askDesktop({ op: "query", hostname: "example.com" })).rejects.toThrow(
			/cannot reach the desktop app/,
		);
	});

	it("declines to reconnect", async () => {
		const mod = await load();
		h.permitted = false;

		expect(await mod.connectToDesktop()).toBe(false);
		expect(h.connects).toBe(0);
	});

	it("reports paired and unpermitted, so the UI can say which", async () => {
		const mod = await load();
		h.permitted = false;

		// Still paired: the keys are intact and nothing was forgotten. Only the browser's
		// permission is missing, which is a different thing to tell the user than "not connected".
		expect(await mod.desktopLinkStatus()).toEqual({ paired: true, pairedAt: 1, permitted: false });
	});

	it("drops the held pipe when the permission is revoked mid-session", async () => {
		const mod = await load();
		const frames: string[] = [];
		await open(mod, frames);
		expect(h.disconnects).toBe(0);

		h.permitted = false;
		for (const cb of h.onPermissionRemoved) cb({ permissions: ["nativeMessaging"] });

		// Held open, the keepalive would rediscover the refusal every twenty seconds forever.
		await vi.waitFor(() => expect(h.disconnects).toBe(1));
	});

	it("ignores the removal of some other permission", async () => {
		const mod = await load();
		const frames: string[] = [];
		await open(mod, frames);

		for (const cb of h.onPermissionRemoved) cb({ permissions: ["clipboardWrite"] });

		await vi.waitFor(() => expect(h.disconnects).toBe(0));
	});
});

// Pairing was not the only thing that needs a borrowed pipe. Everything the UI does immediately
// AFTER pairing runs on the worker that just paired, which has no binding of its own and will not
// get one until it restarts. Claiming the desktop's sync invite is exactly that, and while it was
// gated on this worker's own ability the claim silently answered "no invite" every time: the
// browser got the link and never the vault.
describe("a borrowed pipe serves link requests, not just pairing", () => {
	function lend() {
		const sent: Record<string, unknown>[] = [];
		let onMessage: ((m: unknown) => void) | undefined;
		const port = {
			name: "link-native-proxy",
			sender: { origin: "https://bramble-test.example" },
			postMessage: (m: Record<string, unknown>) => sent.push(m),
			onMessage: {
				addListener: (cb: (m: unknown) => void) => {
					onMessage = cb;
				},
			},
			onDisconnect: { addListener: () => {} },
			disconnect: () => {},
		};
		for (const cb of h.onConnect) cb(port);
		return { sent, deliver: (frame: unknown) => onMessage?.({ frame }) };
	}

	it("answers a request over the lent pipe when this worker has no binding", async () => {
		const mod = await load();
		h.hasBinding = false; // the worker that just paired
		const page = lend();

		const asked = mod.askDesktop({ op: "syncInvite" });
		// hello, then the KK handshake message.
		await vi.waitFor(() => expect(page.sent.length).toBe(3));
		page.deliver({ ok: true, done: true, message: "kk2" });
		await vi.waitFor(() => expect(page.sent.length).toBe(4));
		page.deliver({ sealed: `sealed:${JSON.stringify({ ok: true, invite: "INVITE-CODE" })}` });

		// Before this fix the claim rejected here, and the caller reported "no invite armed".
		await expect(asked).resolves.toEqual({ ok: true, invite: "INVITE-CODE" });
		expect(h.connects).toBe(0);
	});

	it("still refuses when there is neither a binding nor a lent pipe", async () => {
		const mod = await load();
		h.hasBinding = false;

		await expect(mod.askDesktop({ op: "syncInvite" })).rejects.toThrow(
			/cannot reach the desktop app/,
		);
	});

	it("tells a page to lend only when this worker cannot open its own pipe", async () => {
		// Lending on top of a working background would open a SECOND connection, which displaces
		// the first as the target for the app's pushes and takes the queue with it on close.
		const mod = await load();

		expect(await mod.transportNeeded()).toBe(false);
		h.hasBinding = false;
		expect(await mod.transportNeeded()).toBe(true);
		h.hasBinding = true;
		h.permitted = false;
		expect(await mod.transportNeeded()).toBe(true);
	});
});
