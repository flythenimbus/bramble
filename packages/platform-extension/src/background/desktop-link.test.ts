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
	/** How many native ports have been opened; the count IS the connection count. */
	connects: 0,
	disconnects: 0,
	/** Plaintext, keyed by the sealed blob standing in for it. Sealing here is a rename. */
	sealed: new Map<string, string>(),
	stored: {} as Record<string, unknown>,
}));

vi.mock("../platform-api", () => ({
	api: {
		runtime: {
			connectNative: () => {
				h.connects++;
				return {
					postMessage: (msg: Record<string, unknown>) => {
						h.posted.push(msg);
					},
					onMessage: {
						addListener: (cb: (msg: unknown) => void) => h.onMessage.push(cb),
					},
					onDisconnect: {
						addListener: (cb: () => void) => h.onDisconnect.push(cb),
					},
					disconnect: () => {
						h.disconnects++;
					},
				};
			},
			lastError: undefined,
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
			case "LINK_READ":
				return { ok: true, data: undefined };
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
	h.connects = 0;
	h.disconnects = 0;
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
