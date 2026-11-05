import { linkNonceCommit } from "@core/sync/link-sas";
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
	/** What the app answers a caps request with; null for an app from before caps, which
	 * answers an op it does not know with an error. */
	appCaps: ["files"] as string[] | null,
	/** Whether the app offers sync again when asked (`syncRestart`); an older one does not know it. */
	appRestarts: false,
	/** The app's sync identity, answered to `syncIdentity`; null for an app that does not answer. */
	appIdentity: null as string | null,
	/** The refusal the app seals after a handshake, in place of any answer; null to answer. */
	refuseWith: null as string | null,
	/** A seal whose plaintext contains this takes a while, as a busy crypto host's might. */
	slowSeal: null as string | null,
	/** What was written to storage.local, in order. */
	setCalls: [] as Record<string, unknown>[],
	/** Keys removed from storage.local, in order. */
	removed: [] as string[],
	linkCloses: 0,
	/** The vault open in the browser. */
	activeVault: "v1" as string | null,
	/** What the app answers `linkComplete` with over a lent pipe. */
	linkCompleteAnswer: { ok: true } as Record<string, unknown>,
	/** Vault metadata the background reads, by key (the vault registry). */
	meta: {} as Record<string, unknown>,
}));

/** The native port chrome.runtime.connectNative hands back. */
const nativePort = () => {
	h.connects++;
	return {
		postMessage: (msg: Record<string, unknown>) => {
			h.posted.push(msg);
			// The app answers caps as soon as the link is up, as socket.rs does.
			const plain = typeof msg.sealed === "string" ? h.sealed.get(msg.sealed) : undefined;
			if (plain && h.refuseWith) {
				const refusal = { ok: false, error: h.refuseWith };
				queueMicrotask(() => deliver({ sealed: `sealed:${JSON.stringify(refusal)}` }));
				return;
			}
			if (plain && JSON.parse(plain).op === "caps") {
				const answer = h.appCaps
					? { ok: true, caps: h.appCaps }
					: { ok: false, error: "bad request: unknown variant `caps`" };
				queueMicrotask(() => deliver({ sealed: `sealed:${JSON.stringify(answer)}` }));
			}
			if (plain && JSON.parse(plain).op === "syncIdentity" && h.appIdentity) {
				const answer = { ok: true, identity: h.appIdentity };
				queueMicrotask(() => deliver({ sealed: `sealed:${JSON.stringify(answer)}` }));
			}
			if (plain && JSON.parse(plain).op === "syncRestart") {
				const answer = h.appRestarts
					? { ok: true }
					: { ok: false, error: "bad request: unknown variant `syncRestart`" };
				queueMicrotask(() => deliver({ sealed: `sealed:${JSON.stringify(answer)}` }));
			}
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
				set: async (v: Record<string, unknown>) => {
					h.setCalls.push(v);
					Object.assign(h.stored, v);
				},
				remove: async (key: string) => {
					h.removed.push(key);
					delete h.stored[key];
				},
			},
		},
	},
	disconnectReason: () => "disconnected",
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
			case "LINK_PAIR_INITIATOR":
				return { ok: true, data: { sessionId: 11, message: "xl1" } };
			case "LINK_HANDSHAKE_HASH":
				return { ok: true, data: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" };
			case "LINK_REMOTE_STATIC":
				return { ok: true, data: "app-pub" };
			// The KK path ignores this; the pairing path reads `message` off it.
			case "LINK_READ":
				return { ok: true, data: { message: "xx3", done: false } };
			case "LINK_SEAL": {
				const plaintext = msg.payload?.plaintext as string;
				if (h.slowSeal && plaintext.includes(h.slowSeal)) {
					await new Promise((r) => setTimeout(r, 30));
				}
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
				h.linkCloses++;
				return { ok: true, data: undefined };
			default:
				return { ok: false, error: `unexpected ${msg.type}` };
		}
	},
}));

vi.mock("./vek-store", () => ({ getActiveVaultId: () => h.activeVault }));

vi.mock("../storage", () => ({
	extensionStorage: { getMeta: async (key: string) => h.meta[key] ?? null },
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

/** The ops of the sealed frames posted so far, in order. */
const postedOps = () =>
	h.posted
		.filter((m): m is { sealed: string } => typeof m.sealed === "string")
		.map((m) => JSON.parse(h.sealed.get(m.sealed) ?? "{}").op as string);

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
	h.appCaps = ["files"];
	h.appRestarts = false;
	h.appIdentity = null;
	h.refuseWith = null;
	h.slowSeal = null;
	h.activeVault = "v1";
	h.linkCompleteAnswer = { ok: true };
	h.removed.length = 0;
	h.meta = {
		"vault.registry": {
			vaults: [
				{ id: "v1", label: "", createdAt: 1 },
				{ id: "v2", label: "", createdAt: 2 },
			],
		},
	};
	h.stored = {
		"desktopLink:v1": {
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

	it("keeps the vault copy's frames away from sync", async () => {
		const mod = await load();
		const got: [string, string | undefined][] = [];
		const opening = mod.openSyncLink((f, room) => got.push([f, room]));
		await vi.waitFor(() => expect(h.onMessage.length).toBeGreaterThan(0));
		completeHandshake();
		expect(await opening).toBe(true);

		deliver({ sealed: `sealed:${JSON.stringify({ sync: "e", room: "enroll" })}` });
		pushSync("s");

		await vi.waitFor(() => expect(got).toEqual([["s", undefined]]));
	});

	it("sends a sync frame tagged with its room", async () => {
		const mod = await load();
		await open(mod, []);
		h.posted.length = 0;

		expect(await mod.sendSyncFrame("x", "enroll")).toBe(true);

		const sent = h.posted.at(-1) as { sealed: string };
		expect(JSON.parse(h.sealed.get(sent.sealed) ?? "")).toEqual({
			op: "sync",
			frame: "x",
			room: "enroll",
		});
	});

	it("routes an enroll frame even when sync is not running", async () => {
		const mod = await load();
		const got: string[] = [];
		mod.setEnrollFrameSink((f) => got.push(f));
		const opening = mod.openDesktopLink();
		await vi.waitFor(() => expect(h.onMessage.length).toBeGreaterThan(0));
		completeHandshake();
		expect(await opening).toBe(true);

		deliver({ sealed: `sealed:${JSON.stringify({ sync: "e", room: "enroll" })}` });

		await vi.waitFor(() => expect(got).toEqual(["e"]));
	});

	it("asks the app what its vault holds, and reads a refusal as unknown", async () => {
		const mod = await load();
		await open(mod, []);

		const asked = mod.desktopVaultSummary();
		await vi.waitFor(() => expect(postedOps()).toContain("vaultSummary"));
		const summary = { name: "Home", empty: false, entries: 380 };
		deliver({ sealed: `sealed:${JSON.stringify({ ok: true, summary })}` });
		expect(await asked).toEqual(summary);

		const refused = mod.desktopVaultSummary();
		await vi.waitFor(() => expect(postedOps().filter((o) => o === "vaultSummary")).toHaveLength(2));
		deliver({ sealed: `sealed:${JSON.stringify({ ok: false, error: "no summary" })}` });
		expect(await refused).toBeNull();
	});

	it("does not answer a request with a frame the app pushed", async () => {
		// The bug this exists for: the pushed frame arrives between the request and its answer.
		// Handed back as the answer, every later request would return the previous one's result.
		const mod = await load();
		const frames: string[] = [];
		await open(mod, frames);

		const asked = mod.askDesktop({ op: "query", hostname: "example.com" });
		await vi.waitFor(() => expect(postedOps()).toContain("query"));

		pushSync("interleaved");
		deliver({ sealed: `sealed:${JSON.stringify({ ok: true, matches: [] })}` });

		expect(await asked).toEqual({ ok: true, matches: [] });
		expect(frames).toEqual(["interleaved"]);
	});

	it("keeps a frame the app pushes before this end has finished the handshake", async () => {
		// The app may push the moment the link is up, before this side has read the handshake's
		// last message. Dropping that frame put Noise one frame out of step, and nothing on the link
		// could be opened again: the vault summary and invite timed out on a link that looked up.
		const mod = await load();
		const frames: string[] = [];
		const opening = mod.openSyncLink((f) => frames.push(f));
		await vi.waitFor(() => expect(h.onMessage.length).toBeGreaterThan(0));
		completeHandshake();
		pushSync("early");

		expect(await opening).toBe(true);
		await vi.waitFor(() => expect(frames).toEqual(["early"]));
	});

	it("gives each of two overlapping requests its own answer", async () => {
		// Sync asks for the app's identity while a page asks what its vault holds. One shared slot
		// for "the request waiting" handed the first answer to the second asker, and the first
		// timed out: sync took a vault summary for the app's key.
		const mod = await load();
		await open(mod, []);

		const first = mod.askDesktop({ op: "vaultSummary" });
		const second = mod.askDesktop({ op: "syncIdentity" });
		await vi.waitFor(() => expect(postedOps()).toContain("vaultSummary"));
		deliver({ sealed: `sealed:${JSON.stringify({ ok: true, summary: { name: "Home" } })}` });
		await vi.waitFor(() => expect(postedOps()).toContain("syncIdentity"));
		deliver({ sealed: `sealed:${JSON.stringify({ ok: true, identity: "app-key" })}` });

		await expect(first).resolves.toMatchObject({ summary: { name: "Home" } });
		await expect(second).resolves.toMatchObject({ identity: "app-key" });
	});

	it("keeps one connection open rather than one per request", async () => {
		// A second connection displaces this one as the target for the app's pushes, and closing
		// it takes the queue with it: sync goes quiet with nothing reporting a fault.
		const mod = await load();
		const frames: string[] = [];
		await open(mod, frames);
		const afterOpen = h.connects;

		const asked = mod.askDesktop({ op: "query", hostname: "example.com" });
		await vi.waitFor(() => expect(postedOps()).toContain("query"));
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

	it("asks the app to offer sync again on a link held before sync, and keeps the link", async () => {
		// The app offers a browser for sync when it connects, and refuses it while nothing here
		// answers: a link opened to pair, before this browser had a vault. Starting afresh needs a
		// pipe this worker can open, which one granted the permission this session cannot.
		const mod = await load();
		h.appRestarts = true;
		const opening = mod.openDesktopLink();
		await vi.waitFor(() => expect(h.onMessage.length).toBeGreaterThan(0));
		completeHandshake();
		await opening;
		const before = { connects: h.connects, disconnects: h.disconnects };

		expect(await mod.openSyncLink(() => {})).toBe(true);

		expect(postedOps()).toContain("syncRestart");
		expect(h.connects).toBe(before.connects);
		expect(h.disconnects).toBe(before.disconnects);
	});

	it("starts a link held before sync afresh when the app cannot offer it again", async () => {
		// An app from before `syncRestart` offers again only on a new connection, so sync starting
		// on the old one waited forever.
		const mod = await load();
		const opening = mod.openDesktopLink();
		await vi.waitFor(() => expect(h.onMessage.length).toBeGreaterThan(0));
		completeHandshake();
		await opening;
		const before = { connects: h.connects, disconnects: h.disconnects };

		const syncing = mod.openSyncLink(() => {});
		await vi.waitFor(() => expect(h.connects).toBe(before.connects + 1));
		completeHandshake();

		expect(await syncing).toBe(true);
		expect(h.disconnects).toBe(before.disconnects + 1);
	});

	it("keeps the link when sync was already running on it", async () => {
		const mod = await load();
		await open(mod, []);
		const before = { connects: h.connects, disconnects: h.disconnects };

		expect(await mod.openSyncLink(() => {})).toBe(true);

		expect(h.connects).toBe(before.connects);
		expect(h.disconnects).toBe(before.disconnects);
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

describe("files over the held link", () => {
	it("routes the app's file frames and pokes, and sends file frames it can read", async () => {
		const mod = await load();
		const frames: string[] = [];
		const files: [number, string][] = [];
		let pokes = 0;
		mod.openBlobLink(
			(stream, frame) => files.push([stream, frame]),
			() => pokes++,
		);
		await open(mod, frames);
		await vi.waitFor(() => expect(mod.blobLinkUp()).toBe(true));

		deliver({ sealed: `sealed:${JSON.stringify({ blob: "f1", stream: 4 })}` });
		deliver({ sealed: `sealed:${JSON.stringify({ blobPoke: true })}` });
		await vi.waitFor(() => expect(pokes).toBe(1));
		expect(files).toEqual([[4, "f1"]]);
		expect(frames).toEqual([]);

		expect(await mod.sendBlobFrame(4, "back")).toBe(true);
		const sent = h.posted.at(-1) as { sealed: string };
		expect(JSON.parse(h.sealed.get(sent.sealed) ?? "")).toEqual({
			op: "blob",
			stream: 4,
			frame: "back",
		});
	});

	it("sends no file frame to an app from before files, and stays in step with it", async () => {
		// Such an app answers caps with an error. If that answer were left for the next request,
		// every later fill would read the previous request's answer.
		const mod = await load();
		h.appCaps = null;
		const frames: string[] = [];
		await open(mod, frames);
		await vi.waitFor(() => expect(postedOps()).toContain("caps"));

		expect(mod.blobLinkUp()).toBe(false);
		const before = h.posted.length;
		expect(await mod.sendBlobFrame(1, "frame")).toBe(false);
		expect(h.posted.length).toBe(before);

		const asked = mod.askDesktop({ op: "query", hostname: "example.com" });
		await vi.waitFor(() => expect(postedOps()).toContain("query"));
		deliver({ sealed: `sealed:${JSON.stringify({ ok: true, matches: [] })}` });
		expect(await asked).toEqual({ ok: true, matches: [] });
	});

	it("puts frames on the pipe in the order they were sealed", async () => {
		// The app opens them in order; one sent ahead of an earlier seal breaks the session.
		const mod = await load();
		const frames: string[] = [];
		await open(mod, frames);
		await vi.waitFor(() => expect(mod.blobLinkUp()).toBe(true));
		h.slowSeal = "first";

		await Promise.all([mod.sendBlobFrame(1, "first"), mod.sendBlobFrame(1, "second")]);

		const lastTwo = h.posted.slice(-2) as { sealed: string }[];
		expect(lastTwo.map((m) => JSON.parse(h.sealed.get(m.sealed) ?? "{}").frame)).toEqual([
			"first",
			"second",
		]);
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

// Each vault in the browser has its own link, and the worker holds only the open vault's. See
// docs/desktop-link-onboarding.md, piece 3.
describe("a link per vault, over this worker's own pipe", () => {
	const hellos = () => h.posted.filter((m) => m.kind === "hello").map((m) => m.publicKey);
	const second = { privateKey: "priv-2", publicKey: "pub-2", appPublicKey: "app-pub", pairedAt: 2 };

	it("holds the open vault's link, and the next vault's once that one opens", async () => {
		const mod = await load();
		h.stored["desktopLink:v2"] = second;
		const opening = mod.openDesktopLink();
		await vi.waitFor(() => expect(hellos()).toEqual(["pub"]));
		completeHandshake();
		expect(await opening).toBe(true);

		h.activeVault = "v2";
		mod.retargetLink("v2");
		await vi.waitFor(() => expect(hellos()).toEqual(["pub", "pub-2"]));
		completeHandshake();
		await vi.waitFor(() => expect(mod.linkIsHeld()).toBe(true));

		// A vault with no link of its own holds nothing.
		h.activeVault = "v3";
		mod.retargetLink("v3");
		await vi.waitFor(() => expect(mod.linkIsHeld()).toBe(false));
		expect(hellos()).toEqual(["pub", "pub-2"]);
	});

	it("drops the open vault's link when the app says, under the session, nothing there is linked to it", async () => {
		const mod = await load();
		h.refuseWith = "not linked to this app";
		const opening = mod.openDesktopLink();
		await vi.waitFor(() => expect(hellos()).toEqual(["pub"]));
		completeHandshake();

		expect(await opening).toBe(false);
		await vi.waitFor(() => expect(h.stored["desktopLink:v1"]).toBeUndefined());
	});

	it("keeps it when the app only has another vault open", async () => {
		const mod = await load();
		h.refuseWith = "not linked to the open vault";
		const opening = mod.openDesktopLink();
		await vi.waitFor(() => expect(hellos()).toEqual(["pub"]));
		completeHandshake();

		expect(await opening).toBe(false);
		expect(h.stored["desktopLink:v1"]).toBeDefined();
	});

	it("keeps it on a refusal that comes before any handshake, which anything could send", async () => {
		// A second install, or a rewritten host manifest, answers the hello too. Only the app this
		// browser paired with can tell it to drop a link, and only under the session.
		const mod = await load();
		const opening = mod.openDesktopLink();
		await vi.waitFor(() => expect(hellos()).toEqual(["pub"]));
		deliver({ ok: false, error: "not linked to this app" });

		expect(await opening).toBe(false);
		expect(h.stored["desktopLink:v1"]).toBeDefined();
	});

	it("holds the vault that opens during a connect, never the one it started for", async () => {
		const mod = await load();
		h.stored["desktopLink:v2"] = second;
		const opening = mod.openDesktopLink();
		await vi.waitFor(() => expect(hellos()).toEqual(["pub"]));

		h.activeVault = "v2";
		mod.retargetLink("v2");
		await vi.waitFor(() => expect(hellos()).toEqual(["pub", "pub-2"]));
		completeHandshake();
		await opening;

		await vi.waitFor(() => expect(mod.linkIsHeld()).toBe(true));
		expect(mod.heldVault()).toBe("v2");
	});

	it("forgets the link the refusal was about, not the vault opened meanwhile", async () => {
		const mod = await load();
		h.stored["desktopLink:v2"] = second;
		h.refuseWith = "not linked to this app";
		const opening = mod.openDesktopLink();
		await vi.waitFor(() => expect(hellos()).toEqual(["pub"]));
		h.activeVault = "v2";
		completeHandshake();
		await opening;

		await vi.waitFor(() => expect(h.stored["desktopLink:v1"]).toBeUndefined());
		expect(h.stored["desktopLink:v2"]).toBe(second);
	});

	it("forgets a deleted vault's link, and lets go of it when it is the one held", async () => {
		const mod = await load();
		const opening = mod.openDesktopLink();
		await vi.waitFor(() => expect(hellos()).toEqual(["pub"]));
		completeHandshake();
		await opening;

		await mod.forgetVaultLink("v1");

		expect(h.stored["desktopLink:v1"]).toBeUndefined();
		expect(mod.linkIsHeld()).toBe(false);
	});

	it("disconnects one vault's link and says how many remain", async () => {
		const mod = await load();
		h.stored["desktopLink:v2"] = second;

		await expect(mod.unlinkDesktop("v1")).resolves.toEqual({ remaining: 1 });
		expect(h.stored["desktopLink:v2"]).toBe(second);
		await expect(mod.unlinkDesktop("v2")).resolves.toEqual({ remaining: 0 });
	});
});

// An earlier build kept one link for the whole profile. It goes to the vault that syncs with the
// app, which the app's sync identity in that vault's roster shows; with none, it goes.
describe("the single link an earlier build kept", () => {
	const legacy = { privateKey: "priv", publicKey: "pub", appPublicKey: "app-pub", pairedAt: 1 };
	const roster = (...keys: string[]) => ({
		roster: { devices: keys.map((publicKey) => ({ publicKey })) },
	});

	async function connectOnLegacy(mod: Awaited<ReturnType<typeof load>>) {
		h.stored = { desktopLink: legacy };
		const opening = mod.openDesktopLink();
		await vi.waitFor(() => expect(h.onMessage.length).toBeGreaterThan(0));
		completeHandshake();
		return opening;
	}

	it("moves to the vault whose roster holds the app", async () => {
		const mod = await load();
		h.appIdentity = "desk-identity";
		h.meta["sync.group:v1"] = roster("someone-else");
		h.meta["sync.group:v2"] = roster("desk-identity");

		expect(await connectOnLegacy(mod)).toBe(true);

		await vi.waitFor(() => expect(h.stored["desktopLink:v2"]).toEqual(legacy));
		expect(h.stored.desktopLink).toBeUndefined();
	});

	it("is dropped when no vault syncs with the app", async () => {
		const mod = await load();
		h.appIdentity = "desk-identity";
		h.meta["sync.group:v1"] = roster("someone-else");

		await connectOnLegacy(mod);

		await vi.waitFor(() => expect(h.stored.desktopLink).toBeUndefined());
		expect(Object.keys(h.stored).filter((k) => k.startsWith("desktopLink"))).toEqual([]);
	});

	it("waits for proof when more than one vault syncs with the app, then goes to the one that did", async () => {
		// The app has one sync identity for all its vaults, so two rosters can hold it. The link is
		// listed by one desktop vault only, and syncing over it is what shows which.
		const mod = await load();
		h.appIdentity = "desk-identity";
		h.meta["sync.group:v1"] = roster("desk-identity");
		h.meta["sync.group:v2"] = roster("desk-identity");
		expect(await connectOnLegacy(mod)).toBe(true);
		await new Promise((r) => setTimeout(r, 20));
		expect(h.stored.desktopLink).toEqual(legacy);

		await mod.desktopLinkProven("v2");
		expect(h.stored.desktopLink).toEqual(legacy);

		await mod.desktopLinkProven("v1");
		expect(h.stored["desktopLink:v1"]).toEqual(legacy);
		expect(h.stored.desktopLink).toBeUndefined();
	});

	it("goes when the app says, under the session, it is linked to nothing there", async () => {
		const mod = await load();
		h.refuseWith = "not linked to this app";

		await connectOnLegacy(mod);

		await vi.waitFor(() => expect(h.stored.desktopLink).toBeUndefined());
	});

	it("stays, and is used, while the app does not answer", async () => {
		const mod = await load();

		expect(await connectOnLegacy(mod)).toBe(true);
		await new Promise((r) => setTimeout(r, 20));

		expect(h.stored.desktopLink).toEqual(legacy);
		const hellos = h.posted.filter((m) => m.kind === "hello").map((m) => m.publicKey);
		expect(hellos).toEqual(["pub"]);
	});
});

// Pairing runs on a transport the PAGE opens, because the worker cannot open one. A worker that
// was already running when the user granted nativeMessaging never gains connectNative, and the
// open pairing window is itself what stops it restarting to pick the binding up. So the page
// lends a pipe and the handshake, the keys and the storage write all stay here.
describe("pairing borrows the page's native transport", () => {
	/** Hand the background a proxy port, as runtime.onConnect would. */
	function lend(sender: unknown, id = "lent") {
		const sent: Record<string, unknown>[] = [];
		let onMessage: ((m: unknown) => void) | undefined;
		let onDisconnect: (() => void) | undefined;
		let disconnected = false;
		const port = {
			name: `link-native-proxy:${id}`,
			sender,
			postMessage: (m: Record<string, unknown>) => {
				sent.push(m);
				// The app answers caps as soon as a link is up, as socket.rs does.
				const sealed = (m.frame as { sealed?: string } | undefined)?.sealed;
				const plain = sealed ? h.sealed.get(sealed) : undefined;
				const op = plain ? JSON.parse(plain).op : undefined;
				if (op === "caps" || op === "syncRestart" || op === "linkComplete") {
					const answer =
						op === "caps"
							? { ok: true, caps: ["files"] }
							: op === "linkComplete"
								? h.linkCompleteAnswer
								: { ok: true };
					queueMicrotask(() =>
						onMessage?.({ frame: { sealed: `sealed:${JSON.stringify(answer)}` } }),
					);
				}
			},
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
			id,
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
		mod: { pairWithDesktop: (c: string, via?: string) => Promise<unknown> },
		page: ReturnType<typeof lend>,
	) {
		const paired = mod.pairWithDesktop("ABCD1234", page.id);
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

	it("names itself to the desktop app as the browser, not an extension origin", async () => {
		// The desktop lists linked browsers by this label; Firefox has no chrome-extension:// id.
		vi.stubGlobal("navigator", {
			userAgent:
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0",
		});
		try {
			const mod = await load();
			const page = lend(EXT_SENDER);
			await pairOver(mod, page);
			expect(page.sent[1]).toMatchObject({ frame: { kind: "pair", label: "Firefox on Mac" } });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("refuses a port from a content script and does not pair over it", async () => {
		const mod = await load();
		const evil = lend({ origin: "https://evil.example", tab: { id: 1 } });

		expect(evil.disconnected).toBe(true);
		// Rejecting the port is only half of it; it must also never have become the transport.
		// Falling back to a direct session is what proves it did not.
		void mod.pairWithDesktop("ABCD1234", evil.id).catch(() => {});
		await vi.waitFor(() => expect(h.connects).toBe(1));
		expect(evil.sent).toEqual([]);
	});

	it("fails the handshake when the pairing window closes mid-flight", async () => {
		const mod = await load();
		const page = lend(EXT_SENDER);

		const paired = mod.pairWithDesktop("ABCD1234", page.id);
		await vi.waitFor(() => expect(page.sent.length).toBe(3));
		page.drop();

		// Without this the pairing sits on a promise nothing will ever settle, and the UI spins.
		await expect(paired).rejects.toThrow(/pairing window closed/);
	});

	it("surfaces a native host the page could not reach", async () => {
		const mod = await load();
		const page = lend(EXT_SENDER);

		const paired = mod.pairWithDesktop("ABCD1234", page.id);
		await vi.waitFor(() => expect(page.sent.length).toBe(3));
		// The ordinary "desktop app is not installed" case: Chrome reports it as a bare
		// disconnect and the page forwards the reason.
		page.die("Specified native messaging host not found.");

		await expect(paired).rejects.toThrow(/not found/);
	});

	/** Run the emoji link handshake over `page`, resolving what startDesktopLink returned. */
	async function linkOver(mod: Awaited<ReturnType<typeof load>>, page: ReturnType<typeof lend>) {
		const started = mod.startDesktopLink(page.id);
		await vi.waitFor(() => expect(page.sent.length).toBe(3));
		page.deliver({ ok: true, message: "xl2" });
		await vi.waitFor(() => expect(page.sent.length).toBe(4));
		page.deliver({ ok: true, done: true });
		// The nonce exchange: the browser commits, the app answers with its nonce, the browser reveals.
		await vi.waitFor(() => expect(page.sent.length).toBe(5));
		page.deliver({ sealed: `sealed:${JSON.stringify({ ok: true, nonce: APP_NONCE })}` });
		await vi.waitFor(() => expect(page.sent.length).toBe(6));
		page.deliver({ sealed: `sealed:${JSON.stringify({ ok: true })}` });
		return started;
	}

	const APP_NONCE = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
	const opened = (page: ReturnType<typeof lend>, i: number) =>
		JSON.parse(
			h.sealed.get((page.sent[i] as { frame: { sealed: string } }).frame.sealed) ?? "{}",
		) as { op?: string; commit?: string; nonce?: string };

	it("commits to its nonce before it learns the app's, then reveals that same nonce", async () => {
		const mod = await load();
		const page = lend(EXT_SENDER);
		await linkOver(mod, page);

		const commit = opened(page, 4);
		const reveal = opened(page, 5);
		expect(commit.op).toBe("linkCommit");
		expect(reveal.op).toBe("linkReveal");
		expect(await linkNonceCommit(reveal.nonce ?? "")).toBe(commit.commit);
	});

	it("links by emoji, storing the app only after the user confirms and the app agrees", async () => {
		const mod = await load();
		h.setCalls.length = 0;
		const page = lend(EXT_SENDER);
		const started = await linkOver(mod, page);
		expect(page.sent[1]).toMatchObject({ frame: { kind: "link" } });
		if (!("id" in started)) throw new Error("expected a link in progress");
		expect(started.sas.emoji).toHaveLength(7);

		const confirmed = mod.confirmDesktopLink(started.id, true);
		await vi.waitFor(() => expect(page.sent.length).toBe(7));
		const sealed = (page.sent[6] as { frame: { sealed: string } }).frame.sealed;
		expect(JSON.parse(h.sealed.get(sealed) ?? "{}")).toEqual({ op: "linkConfirm" });
		expect(h.setCalls).toEqual([]);
		page.deliver({ sealed: `sealed:${JSON.stringify({ ok: true, paired: true })}` });

		await expect(confirmed).resolves.toMatchObject({ appPublicKey: "app-pub" });
		// Stored once the flow ends with a vault holding the desktop's: see "links per vault".
		expect(h.setCalls).toEqual([]);
		await mod.attachLink("v2");
		expect(h.setCalls).toEqual([
			{ "desktopLink:v2": expect.objectContaining({ appPublicKey: "app-pub" }) },
		]);
	});

	it("drops a held link once a new link is stored, so later requests speak as the new key", async () => {
		// The app binds its invite to the key that just linked. A held link opened under the
		// previous key made the claim look like another browser's, and the vault never came.
		const mod = await load();
		await open(mod, []);
		const before = h.disconnects;
		const page = lend(EXT_SENDER);
		const started = await linkOver(mod, page);
		if (!("id" in started)) throw new Error("expected a link in progress");

		const confirmed = mod.confirmDesktopLink(started.id, true);
		await vi.waitFor(() => expect(page.sent.length).toBe(7));
		page.deliver({ sealed: `sealed:${JSON.stringify({ ok: true, paired: true })}` });
		await confirmed;

		expect(h.disconnects).toBe(before + 1);
	});

	it("keeps the link's own pipe as the held link, so a worker without one can still sync", async () => {
		// A browser that granted the permission at link time has a worker that cannot open a pipe
		// until it restarts. The vault copy rides the held link, so closing the link's own pipe
		// left the copy nothing to ride: it stalled at "connecting to inviter".
		const mod = await load();
		h.hasBinding = false;
		const page = lend(EXT_SENDER);
		const started = await linkOver(mod, page);
		if (!("id" in started)) throw new Error("expected a link in progress");
		const closes = h.linkCloses;

		const confirmed = mod.confirmDesktopLink(started.id, true);
		await vi.waitFor(() => expect(page.sent.length).toBe(7));
		page.deliver({ sealed: `sealed:${JSON.stringify({ ok: true, paired: true })}` });
		await confirmed;

		expect(mod.linkIsHeld()).toBe(true);
		expect(h.linkCloses).toBe(closes);
		await expect(mod.sendSyncFrame("frame-1", "enroll")).resolves.toBe(true);
		const last = page.sent.at(-1) as { frame: { sealed: string } };
		expect(JSON.parse(h.sealed.get(last.frame.sealed) ?? "{}")).toMatchObject({
			op: "sync",
			frame: "frame-1",
		});
	});

	it("keeps sync on the link's own pipe once sync starts, asking the app to offer again", async () => {
		const mod = await load();
		h.hasBinding = false;
		const page = lend(EXT_SENDER);
		const started = await linkOver(mod, page);
		if (!("id" in started)) throw new Error("expected a link in progress");
		const confirmed = mod.confirmDesktopLink(started.id, true);
		await vi.waitFor(() => expect(page.sent.length).toBe(7));
		page.deliver({ sealed: `sealed:${JSON.stringify({ ok: true, paired: true })}` });
		await confirmed;

		const frames: string[] = [];
		await mod.openSyncLink((f) => frames.push(f));
		page.deliver({ sealed: `sealed:${JSON.stringify({ sync: "offer" })}` });

		await vi.waitFor(() => expect(frames).toEqual(["offer"]));
		expect(mod.linkIsHeld()).toBe(true);
	});

	it("loses no frame the app pushes right after it approves", async () => {
		// The app serves the link as soon as it answers, and may push at once. A frame nobody
		// claimed was dropped, and Noise, which numbers frames, was out of step from then on.
		const mod = await load();
		const enrolled: string[] = [];
		mod.setEnrollFrameSink((f) => enrolled.push(f));
		const page = lend(EXT_SENDER);
		const started = await linkOver(mod, page);
		if (!("id" in started)) throw new Error("expected a link in progress");

		const confirmed = mod.confirmDesktopLink(started.id, true);
		await vi.waitFor(() => expect(page.sent.length).toBe(7));
		page.deliver({ sealed: `sealed:${JSON.stringify({ ok: true, paired: true })}` });
		page.deliver({ sealed: `sealed:${JSON.stringify({ sync: "offer", room: "enroll" })}` });
		await confirmed;

		await vi.waitFor(() => expect(enrolled).toEqual(["offer"]));
	});

	it("drops a held link once a code pairing is stored, for the same reason", async () => {
		const mod = await load();
		await open(mod, []);
		const before = h.disconnects;
		await pairOver(mod, lend(EXT_SENDER));

		expect(h.disconnects).toBe(before + 1);
	});

	it("stores nothing when the user says the emoji do not match", async () => {
		const mod = await load();
		h.setCalls.length = 0;
		const page = lend(EXT_SENDER);
		const started = await linkOver(mod, page);
		if (!("id" in started)) throw new Error("expected a link in progress");

		await expect(mod.confirmDesktopLink(started.id, false)).rejects.toThrow();
		expect(h.setCalls).toEqual([]);
	});

	it("stores nothing when the app refuses after the user confirms", async () => {
		const mod = await load();
		h.setCalls.length = 0;
		const page = lend(EXT_SENDER);
		const started = await linkOver(mod, page);
		if (!("id" in started)) throw new Error("expected a link in progress");

		const confirmed = mod.confirmDesktopLink(started.id, true);
		await vi.waitFor(() => expect(page.sent.length).toBe(7));
		page.deliver({ sealed: `sealed:${JSON.stringify({ ok: false, error: "refused" })}` });

		await expect(confirmed).rejects.toThrow();
		expect(h.setCalls).toEqual([]);
	});

	it("says the app did not approve when it drops the link instead of answering", async () => {
		// What a desktop that approved and then closed its dialog looks like from here: it shuts the
		// pipe rather than answer. The browser's own wording for that is no message for a person.
		const mod = await load();
		h.setCalls.length = 0;
		const page = lend(EXT_SENDER);
		const started = await linkOver(mod, page);
		if (!("id" in started)) throw new Error("expected a link in progress");

		const confirmed = mod.confirmDesktopLink(started.id, true);
		await vi.waitFor(() => expect(page.sent.length).toBe(7));
		page.die("Native host has exited.");

		await expect(confirmed).rejects.toThrow("The desktop app did not approve the link.");
		expect(h.setCalls).toEqual([]);
	});

	it("falls back to the code for an app that does not know the link hello", async () => {
		const mod = await load();
		const page = lend(EXT_SENDER);
		const started = mod.startDesktopLink(page.id);
		await vi.waitFor(() => expect(page.sent.length).toBe(3));
		// An older app closes the connection on an unknown hello without a word.
		page.die("Native host has exited.");

		await expect(started).resolves.toEqual({ legacy: true });
	});

	it("lets go of a link the user walks away from", async () => {
		const mod = await load();
		const page = lend(EXT_SENDER);
		const started = await linkOver(mod, page);
		if (!("id" in started)) throw new Error("expected a link in progress");

		const before = h.linkCloses;
		await mod.cancelDesktopLink(started.id);

		expect(h.linkCloses).toBe(before + 1);
		await expect(mod.confirmDesktopLink(started.id, true)).rejects.toThrow(/no longer in progress/);
	});

	it("drops an unanswered link once the app's window has closed anyway", async () => {
		const mod = await load();
		const page = lend(EXT_SENDER);
		const started = await linkOver(mod, page);
		if (!("id" in started)) throw new Error("expected a link in progress");

		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 3 * 60_000 + 1);
		await expect(mod.confirmDesktopLink(started.id, true)).rejects.toThrow(/no longer in progress/);
		vi.useRealTimers();
	});

	it("says the app is missing on Firefox too, rather than offering the code", async () => {
		const mod = await load();
		const page = lend(EXT_SENDER);
		const started = mod.startDesktopLink(page.id);
		await vi.waitFor(() => expect(page.sent.length).toBe(3));
		// Firefox's wording for a native host that is not installed.
		page.die("No such native application app.bramble.desktop");

		await expect(started).rejects.toThrow(/No such native application/);
	});

	it("says to open the app's Connect dialog when the app refuses the hello", async () => {
		const mod = await load();
		const page = lend(EXT_SENDER);
		const started = mod.startDesktopLink(page.id);
		await vi.waitFor(() => expect(page.sent.length).toBe(3));
		page.deliver({ ok: false, error: "refused" });

		await expect(started).rejects.toThrow(/Connect a browser/);
	});

	/** Link over `page` and have both screens agree, leaving the link in progress. */
	async function confirmOver(mod: Awaited<ReturnType<typeof load>>, page: ReturnType<typeof lend>) {
		const started = await linkOver(mod, page);
		if (!("id" in started)) throw new Error("expected a link in progress");
		const confirmed = mod.confirmDesktopLink(started.id, true);
		await vi.waitFor(() => expect(page.sent.length).toBe(7));
		page.deliver({ sealed: `sealed:${JSON.stringify({ ok: true, paired: true })}` });
		return confirmed;
	}

	/** The plaintext of every sealed frame posted to `page`, as ops. */
	const opsOn = (page: ReturnType<typeof lend>) =>
		page.sent
			.map((m) => (m.frame as { sealed?: string } | undefined)?.sealed)
			.filter((x): x is string => typeof x === "string")
			.map((x) => JSON.parse(h.sealed.get(x) ?? "{}").op as string | undefined);

	describe("links per vault", () => {
		it("keeps a confirmed link in progress, stored nowhere, until it attaches", async () => {
			const mod = await load();
			h.setCalls.length = 0;
			await confirmOver(mod, lend(EXT_SENDER));

			expect(h.setCalls).toEqual([]);
			expect(mod.linkIsHeld()).toBe(true);
		});

		it("stores an attached link under that vault, and tells the app", async () => {
			const mod = await load();
			const page = lend(EXT_SENDER);
			await confirmOver(mod, page);

			await expect(mod.attachLink("v2")).resolves.toBe(true);

			expect(h.stored["desktopLink:v2"]).toMatchObject({
				publicKey: "pub",
				appPublicKey: "app-pub",
			});
			expect(opsOn(page)).toContain("linkComplete");
		});

		it("keeps a link in progress held while the open vault changes", async () => {
			// The vault copy changes the open vault itself, to the vault it creates.
			const mod = await load();
			await confirmOver(mod, lend(EXT_SENDER));

			h.activeVault = "v9";
			mod.retargetLink("v9");

			expect(mod.linkIsHeld()).toBe(true);
		});

		it("stores nothing for a link abandoned before it attaches", async () => {
			const mod = await load();
			h.setCalls.length = 0;
			await confirmOver(mod, lend(EXT_SENDER));

			await mod.abandonLink();

			expect(h.setCalls).toEqual([]);
			expect(mod.linkIsHeld()).toBe(false);
			await expect(mod.attachLink("v2")).resolves.toBe(false);
		});

		it("stores nothing when there is no link in progress to attach", async () => {
			// What a worker restarted mid-copy sees: the link in progress went with it.
			const mod = await load();
			h.setCalls.length = 0;

			await expect(mod.attachLink("v2")).resolves.toBe(false);
			expect(h.setCalls).toEqual([]);
		});

		it("leaves another vault's link alone when linking, attaching or abandoning", async () => {
			const mod = await load();
			const before = h.stored["desktopLink:v1"];
			await confirmOver(mod, lend(EXT_SENDER, "first"));
			await mod.abandonLink();
			await confirmOver(mod, lend(EXT_SENDER, "second"));
			await mod.attachLink("v2");

			expect(h.stored["desktopLink:v1"]).toBe(before);
			expect(h.removed).toEqual([]);
		});

		it("does not attach a link the app will not complete, and lets it go", async () => {
			// The app forgot it: its Connect window closed, or the pending link expired.
			const mod = await load();
			h.linkCompleteAnswer = { ok: false, error: "no link to complete" };
			await confirmOver(mod, lend(EXT_SENDER));

			await expect(mod.attachLink("v2")).resolves.toBe(false);
			expect(h.stored["desktopLink:v2"]).toBeUndefined();
			expect(mod.linkIsHeld()).toBe(false);
		});

		it("lets go of an attached link whose vault is not the one open now", async () => {
			// The vault switched elsewhere during the copy: the link is stored for its vault, and
			// the one held is the open vault's own.
			const mod = await load();
			await confirmOver(mod, lend(EXT_SENDER));
			h.activeVault = "v1";

			await expect(mod.attachLink("v2")).resolves.toBe(true);

			expect(h.stored["desktopLink:v2"]).toBeDefined();
			expect(mod.heldVault()).not.toBe("v2");
		});

		it("holds an attached code pairing as that vault's, not as one still in progress", async () => {
			const mod = await load();
			h.activeVault = "v2";
			await pairOver(mod, lend(EXT_SENDER));
			const opening = mod.openDesktopLink();
			await vi.waitFor(() => expect(h.onMessage.length).toBeGreaterThan(0));
			completeHandshake();
			await opening;

			await mod.attachLink("v2");

			expect(mod.heldVault()).toBe("v2");
		});

		it("keeps a code pairing in progress too, until it attaches", async () => {
			const mod = await load();
			h.setCalls.length = 0;
			await pairOver(mod, lend(EXT_SENDER));

			expect(h.setCalls).toEqual([]);
			await expect(mod.attachLink("v2")).resolves.toBe(true);
			expect(h.stored["desktopLink:v2"]).toBeDefined();
		});

		it("attaches a link to an app from before linkComplete, which listed it already", async () => {
			const mod = await load();
			h.linkCompleteAnswer = { ok: false, error: "bad request: unknown variant `linkComplete`" };
			await confirmOver(mod, lend(EXT_SENDER));

			await expect(mod.attachLink("v2")).resolves.toBe(true);
			expect(h.stored["desktopLink:v2"]).toBeDefined();
		});
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
	function lend(id = "lent") {
		const sent: Record<string, unknown>[] = [];
		let onMessage: ((m: unknown) => void) | undefined;
		const port = {
			name: `link-native-proxy:${id}`,
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

		const asked = mod.askDesktop({ op: "syncInvite" }, "lent");
		// hello, then the KK handshake message.
		await vi.waitFor(() => expect(page.sent.length).toBe(3));
		page.deliver({ ok: true, done: true, message: "kk2" });
		await vi.waitFor(() => expect(page.sent.length).toBe(4));
		page.deliver({ sealed: `sealed:${JSON.stringify({ ok: true, invite: "INVITE-CODE" })}` });

		// Before this fix the claim rejected here, and the caller reported "no invite armed".
		await expect(asked).resolves.toEqual({ ok: true, invite: "INVITE-CODE" });
		expect(h.connects).toBe(0);
	});

	const hellos = (page: ReturnType<typeof lend>) =>
		page.sent.filter((m) => (m.frame as { kind?: string } | undefined)?.kind === "hello").length;

	it("gives each request its own lent pipe, even when two run at once", async () => {
		// The app reads a connection as one session. Settings asks for the app's sync key while the
		// link flow asks for its vault: on one shared pipe the second hello arrived where the app
		// expected a sealed frame, the app dropped the connection, and the invite never came.
		const mod = await load();
		h.hasBinding = false;
		const a = lend("a");
		const b = lend("b");

		const first = mod.askDesktop({ op: "vaultSummary" }, "a");
		const second = mod.askDesktop({ op: "syncIdentity" }, "b");
		await vi.waitFor(() => expect(hellos(a) + hellos(b)).toBe(2));
		expect(hellos(a)).toBe(1);
		expect(hellos(b)).toBe(1);

		for (const page of [a, b]) page.deliver({ ok: true, done: true, message: "kk2" });
		await vi.waitFor(() => expect(a.sent.length).toBe(4));
		await vi.waitFor(() => expect(b.sent.length).toBe(4));
		a.deliver({ sealed: `sealed:${JSON.stringify({ ok: true, summary: "A" })}` });
		b.deliver({ sealed: `sealed:${JSON.stringify({ ok: true, identity: "B" })}` });
		await expect(first).resolves.toEqual({ ok: true, summary: "A" });
		await expect(second).resolves.toEqual({ ok: true, identity: "B" });
	});

	it("keeps a pipe lent for one request away from every other", async () => {
		// Sync asks for the app's key on its own. A pipe a page lent for the emoji link must not
		// carry it: the app would read its hello as the link's next frame.
		const mod = await load();
		h.hasBinding = false;
		const page = lend("link");

		await expect(mod.askDesktop({ op: "syncIdentity" })).rejects.toThrow(
			/cannot reach the desktop app/,
		);
		expect(page.sent).toEqual([{ ready: true }]);
	});

	it("carries one session per lent pipe, never a second", async () => {
		const mod = await load();
		h.hasBinding = false;
		const page = lend("once");

		void mod.askDesktop({ op: "syncInvite" }, "once").catch(() => {});
		await vi.waitFor(() => expect(hellos(page)).toBe(1));
		await expect(mod.askDesktop({ op: "syncInvite" }, "once")).rejects.toThrow(
			/cannot reach the desktop app/,
		);
		expect(hellos(page)).toBe(1);
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
