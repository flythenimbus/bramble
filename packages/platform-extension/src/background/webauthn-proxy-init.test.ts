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
	completeCreateRequest: async () => {},
	completeGetRequest: async () => {},
	completeIsUvpaaRequest: () => {},
	onCreateRequest: {
		addListener: () => {
			h.listeners.create++;
		},
	},
	onGetRequest: {
		addListener: () => {
			h.listeners.get++;
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
	setProviderApplyHook: (fn: (enabled: boolean) => Promise<void>) => {
		h.applyHook = fn;
	},
}));

vi.mock("./webauthn-proxy", () => ({
	handleCreate: vi.fn(async () => ({ requestId: 1, responseJson: "{}" })),
	handleGet: vi.fn(async () => ({ requestId: 1, responseJson: "{}" })),
}));

async function load() {
	vi.resetModules();
	h.attachCalls = 0;
	h.detachCalls = 0;
	h.attachResult = undefined;
	h.hasProxy = true;
	h.listeners = { create: 0, get: 0, isUvpaa: 0 };
	h.handlers.clear();
	h.applyHook = undefined;
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

	it("attaches once and registers each listener exactly once across re-init", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		await m.initWebauthnProxy();
		expect(h.attachCalls).toBe(1);
		expect(h.listeners).toEqual({ create: 1, get: 1, isUvpaa: 1 });
	});

	it("does nothing on a platform without the proxy namespace", async () => {
		const m = await load();
		h.hasProxy = false;
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

	it("HOLE: resume re-attaches even after the provider was toggled off", async () => {
		// Toggling off while paused is a no-op (already detached), so RESUME resurrects a proxy
		// the user just disabled, and nothing downstream re-checks the pref. Flip target: F1.
		const m = await load();
		await m.initWebauthnProxy();
		await pause();
		await h.applyHook?.(false);
		expect(h.detachCalls).toBe(1); // the toggle's detach did nothing; pause had already detached
		await resume();
		expect(h.attachCalls).toBe(2); // attached again, with the pref off
	});

	it("HOLE: a startup attach ignores a ceremony already in progress", async () => {
		// PAUSE before the startup attach lands: `attached` is false so the pause is not recorded,
		// then init attaches mid-ceremony and can hijack our own security-key tap. Flip target: F4.
		const m = await load();
		await pause();
		await m.initWebauthnProxy();
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

describe("the settings toggle hook", () => {
	it("attaches when enabled and detaches when disabled", async () => {
		await load();
		await h.applyHook?.(true);
		expect(h.attachCalls).toBe(1);
		await h.applyHook?.(false);
		expect(h.detachCalls).toBe(1);
	});
});
