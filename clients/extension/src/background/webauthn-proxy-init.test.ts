import { beforeEach, describe, expect, it, vi } from "vitest";

// The attach/detach state machine behind the passkey provider. Four module-level variables
// (attached, pauseDepth, pausedWhileAttached, listenersRegistered) decide whether Chrome routes
// EVERY WebAuthn call in the browser to us, so a wrong state is not a local bug: it silently
// breaks the user's other authenticators, or silently stops serving ours.
//
// Written as characterization tests during a spike, so the cases marked HOLE pin behaviour that
// is currently WRONG. Each names the fix that will flip it. See docs/passkey-provider.md.
//
// vi.resetModules() is the service-worker death simulator: a fresh module graph has all four
// variables back at their initial values, which is exactly what a killed and re-woken worker
// looks like. Nothing persists them.

const h = vi.hoisted(() => ({
	attachCalls: 0,
	detachCalls: 0,
	/** What attach() resolves to. A string is Chrome's failure mode, undefined is success. */
	attachResult: undefined as string | undefined,
	/** Firefox has no such namespace at all, which is a branch the module must survive. */
	hasProxy: true,
	/** addListener counts per event, to prove registration happens exactly once. */
	listeners: { create: 0, get: 0, isUvpaa: 0 },
	/** Router handlers the module registers, by message type. */
	handlers: new Map<string, (m: unknown) => Promise<unknown>>(),
	/** The attach/detach hook the module hands to the provider module. */
	applyHook: undefined as ((enabled: boolean) => Promise<void>) | undefined,
	/** The persisted opt-in, which RESUME re-checks before re-attaching. */
	enabled: true,
	/** Completions we sent back to Chrome, in order. */
	completed: [] as { requestId: number; kind: string; error?: string }[],
	/** The request listeners themselves, so a test can deliver a request. */
	fire: {} as {
		create?: (r: { requestId: number }) => void;
		get?: (r: { requestId: number }) => void;
	},
	/** Hold the handler mid-ceremony, which is where a real one spends most of its life. */
	holdHandler: false,
	release: undefined as (() => void) | undefined,
}));

const proxy = {
	attach: async () => {
		h.attachCalls++;
		return h.attachResult;
	},
	detach: async () => {
		h.detachCalls++;
		return undefined;
	},
	completeCreateRequest: async (d: { requestId: number; error?: { message: string } }) => {
		h.completed.push({ requestId: d.requestId, kind: "create", error: d.error?.message });
	},
	completeGetRequest: async (d: { requestId: number; error?: { message: string } }) => {
		h.completed.push({ requestId: d.requestId, kind: "get", error: d.error?.message });
	},
	completeIsUvpaaRequest: () => {},
	onCreateRequest: {
		addListener: (cb: (r: { requestId: number }) => void) => {
			h.listeners.create++;
			h.fire.create = cb;
		},
	},
	onGetRequest: {
		addListener: (cb: (r: { requestId: number }) => void) => {
			h.listeners.get++;
			h.fire.get = cb;
		},
	},
	onIsUvpaaRequest: {
		addListener: () => {
			h.listeners.isUvpaa++;
		},
	},
};

vi.mock("../platform-api", () => ({
	api: {
		// A getter so one test can be Firefox (namespace absent) without a second mock.
		get webAuthenticationProxy() {
			return h.hasProxy ? proxy : undefined;
		},
		tabs: { query: async () => [{ id: 1, url: "https://example.com/page" }] },
	},
}));

vi.mock("./router", () => ({
	on: (type: string, handler: (m: unknown) => Promise<unknown>) => h.handlers.set(type, handler),
	// Resolved, or the proxy listeners would hang waiting on hydration.
	whenReady: async () => {},
}));

vi.mock("./webauthn-provider", () => ({
	productionDeps: {},
	isProviderEnabled: () => h.enabled,
	setProviderApplyHook: (fn: (enabled: boolean) => Promise<void>) => {
		h.applyHook = fn;
	},
}));

// Echo the requestId back, as the real handlers do; the tests below key on it. `holdHandler`
// parks the handler where a real ceremony sits: awaiting the user, for up to two minutes.
const answer = (requestId: number) => {
	if (!h.holdHandler) return Promise.resolve({ requestId, responseJson: "{}" });
	return new Promise((resolve) => {
		h.release = () => resolve({ requestId, responseJson: "{}" });
	});
};

vi.mock("./webauthn-proxy", () => ({
	handleCreate: vi.fn((_deps: unknown, requestId: number) => answer(requestId)),
	handleGet: vi.fn((_deps: unknown, requestId: number) => answer(requestId)),
}));

/** Fresh module state, as a re-woken service worker has. `hasProxy: false` is Firefox, and must
 *  be set before the import now that listener registration happens at module scope. */
async function load({ hasProxy = true } = {}) {
	vi.resetModules();
	h.attachCalls = 0;
	h.detachCalls = 0;
	h.attachResult = undefined;
	h.hasProxy = hasProxy;
	h.listeners = { create: 0, get: 0, isUvpaa: 0 };
	h.handlers.clear();
	h.applyHook = undefined;
	h.enabled = true;
	h.completed = [];
	h.fire = {};
	h.holdHandler = false;
	h.release = undefined;
	return import("./webauthn-proxy-init");
}

/** Drive a router message the module registered, as the popup's pauser would. */
const send = (type: string) => h.handlers.get(type)?.({ type });

const pause = () => send("PASSKEY_PROXY_PAUSE");
const resume = () => send("PASSKEY_PROXY_RESUME");

describe("initWebauthnProxy", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("registers listeners at import, before anything attaches", async () => {
		// The window this closes: attachment survives worker death, listeners do not, and a
		// request arriving before they exist is lost for good.
		await load();
		expect(h.listeners).toEqual({ create: 1, get: 1, isUvpaa: 1 });
		expect(h.attachCalls).toBe(0);
	});

	it("attaches once and registers each listener exactly once across re-init", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		await m.initWebauthnProxy();
		expect(h.attachCalls).toBe(1);
		expect(h.listeners).toEqual({ create: 1, get: 1, isUvpaa: 1 });
	});

	it("does nothing on a platform without the proxy namespace", async () => {
		const m = await load({ hasProxy: false }); // Firefox
		await expect(m.initWebauthnProxy()).resolves.toBeUndefined();
		expect(h.attachCalls).toBe(0);
		expect(h.listeners).toEqual({ create: 0, get: 0, isUvpaa: 0 });
	});

	it("propagates an attach failure and stays retryable", async () => {
		const m = await load();
		h.attachResult = "another extension is attached";
		await expect(m.initWebauthnProxy()).rejects.toThrow(/another extension is attached/);
		// `attached` was never set, so a later attempt still tries.
		h.attachResult = undefined;
		await m.initWebauthnProxy();
		expect(h.attachCalls).toBe(2);
	});
});

describe("pause and resume", () => {
	it("detaches for the ceremony and re-attaches after it", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		await pause();
		expect(h.detachCalls).toBe(1);
		await resume();
		expect(h.attachCalls).toBe(2);
	});

	it("re-attaches only at depth zero when pauses nest", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		await pause();
		await pause();
		await resume();
		expect(h.attachCalls).toBe(1); // still inside the outer pause
		await resume();
		expect(h.attachCalls).toBe(2);
	});

	it("does not attach on resume when the pause began while detached", async () => {
		await load();
		await pause();
		await resume();
		expect(h.attachCalls).toBe(0);
	});

	it("HOLE: a lost resume strands the proxy, and a later good cycle cannot recover it", async () => {
		// The popup owns the RESUME send from a `finally`; Chrome destroying it (click away during
		// the key tap) drops the message. Flip target: F2, a port whose disconnect the browser
		// guarantees.
		const m = await load();
		await m.initWebauthnProxy();
		await pause(); // ceremony starts, proxy detaches
		// ...popup dies here, no resume.
		await pause();
		await resume();
		expect(h.attachCalls).toBe(1); // depth 2 -> 1, never reaches zero
		expect(h.detachCalls).toBe(1);
	});

	it("does not resurrect a proxy the user turned off mid-ceremony", async () => {
		// The toggle's own detach is a no-op while we are already paused-detached, so RESUME is the
		// only place left to notice. Without the pref re-check this re-attached with the pref off.
		const m = await load();
		await m.initWebauthnProxy();
		await pause();
		await h.applyHook?.(false);
		h.enabled = false;
		expect(h.detachCalls).toBe(1); // the toggle's detach did nothing; pause had already detached
		await resume();
		expect(h.attachCalls).toBe(1); // still just the original attach
	});

	it("defers a startup attach that lands during a ceremony", async () => {
		// PAUSE before the startup attach: attaching anyway would intercept our own security-key
		// tap, since the proxy does NOT exempt our extension origin (docs/passkey-provider.md).
		const m = await load();
		await pause();
		await m.initWebauthnProxy();
		expect(h.attachCalls).toBe(0);
		await resume(); // the deferred attach lands when the ceremony ends
		expect(h.attachCalls).toBe(1);
	});

	it("forgets an in-progress pause when the worker dies", async () => {
		// Not a hole the module can close on its own: the state is in-memory only, so a fresh
		// worker re-attaches mid-ceremony. Only a pause the new worker can observe fixes it (F2).
		const m = await load();
		await m.initWebauthnProxy();
		await pause();
		expect(h.detachCalls).toBe(1);

		const revived = await load(); // service-worker death
		await revived.initWebauthnProxy();
		expect(h.attachCalls).toBe(1); // counters reset with the module; the point is it attached
	});
});

describe("in-flight requests during a pause", () => {
	/** Let the listener's async body run to the point where it would complete the request. */
	const settle = () => new Promise((r) => setTimeout(r, 0));

	it("fails a request the pause is about to kill, with a reason", async () => {
		// Detaching aborts it anyway, but as a bare AbortError with onRequestCanceled never firing,
		// so the site gets no reason and we would not know to stop the ceremony.
		const m = await load();
		await m.initWebauthnProxy();
		h.holdHandler = true;
		h.fire.get?.({ requestId: 42 });
		await settle(); // the ceremony is now awaiting the user

		await pause();
		expect(h.completed).toEqual([
			{ requestId: 42, kind: "get", error: expect.stringContaining("paused passkey handling") },
		]);
	});

	it("does not complete a request twice when the ceremony finishes after the pause", async () => {
		// The second completion throws "Invalid sender", and the user has been walked through a
		// picker for a request that no longer exists.
		const m = await load();
		await m.initWebauthnProxy();
		h.holdHandler = true;
		h.fire.get?.({ requestId: 7 });
		await settle();
		await pause();
		h.completed = []; // drop the pause's own failure; we care about what comes after
		h.release?.(); // the user finally finishes the ceremony
		await settle();
		expect(h.completed).toEqual([]);
	});

	it("completes normally when no pause interrupts", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		h.fire.get?.({ requestId: 9 });
		await settle();
		expect(h.completed).toEqual([{ requestId: 9, kind: "get", error: undefined }]);
	});
});

describe("the settings toggle hook", () => {
	it("attaches when enabled and detaches when disabled", async () => {
		await load();
		await h.applyHook?.(true);
		expect(h.attachCalls).toBe(1);
		await h.applyHook?.(false);
		expect(h.detachCalls).toBe(1);
	});
});
