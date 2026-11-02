import { describe, expect, it, vi } from "vitest";

// The passkey-provider enabled flag: one in-memory boolean that gates both deliveries (Chrome's
// attach, Firefox's content transport). Both ways it used to end up disagreeing with reality (a
// stale startup read overwriting a newer toggle, and a failed apply leaving it claiming enabled)
// are covered here.
//
// See webauthn-proxy-init.test.ts for the attach state machine itself, and
// docs/passkey-provider.md for the spike these came out of.

const h = vi.hoisted(() => ({
	/** Router handlers the module registers, by message type. */
	handlers: new Map<string, (m: unknown) => Promise<unknown>>(),
	/** Resolver for the pref read, so a test can hold startup mid-flight. */
	settlePref: undefined as ((enabled: boolean) => void) | undefined,
	/** Enabled values the apply hook was called with, in order. */
	applied: [] as boolean[],
	/** Whether the apply hook throws, as a failing attach() does. */
	hookThrows: false,
	/** Settles the running ceremony, so a test can hold one mid-flight. */
	releaseCeremony: undefined as (() => void) | undefined,
	/** What the mocked get ceremony does with its host (default: wait for releaseCeremony). */
	runGet: undefined as
		| ((host: { verifyUser: () => Promise<boolean> }) => Promise<unknown>)
		| undefined,
	/** App routes the provider opened in a detached window, and the handlers marked extension-only. */
	openedPaths: [] as string[],
	extensionOnly: new Set<unknown>(),
}));

vi.mock("./prefs", () => ({
	getPasskeyProviderEnabled: () =>
		new Promise<boolean>((resolve) => {
			h.settlePref = resolve;
		}),
}));

vi.mock("./router", () => ({
	on: (type: string, handler: (m: unknown) => Promise<unknown>) => h.handlers.set(type, handler),
	extensionOnly: (handler: unknown) => {
		h.extensionOnly.add(handler);
		return handler;
	},
}));

vi.mock("./popout", () => ({
	openUnlockView: async () => undefined,
	openPopoutAt: async (path: string) => {
		h.openedPaths.push(path);
		return 99;
	},
}));

vi.mock("../platform-api", () => ({
	api: {
		runtime: { sendMessage: async () => {} },
		tabs: { query: async () => [], sendMessage: async () => {} },
		action: {},
		windows: { create: async () => ({ id: 1 }), remove: async () => {} },
	},
}));

vi.mock("./passkey-store", () => ({
	loadDecryptedEntries: async () => [],
	passkeyGetAssertion: async () => ({ authenticatorData: "", signature: "" }),
	passkeyMakeCredential: async () => ({}),
	passkeyPrfEval: async () => ({ first: "" }),
	savePlacement: async () => {},
}));

vi.mock("./session", () => ({ vaultLocked: () => false }));

vi.mock("./webauthn-proxy", () => ({
	runCreateCeremony: async () => ({ approved: false }),
	runGetCeremony: (_req: unknown, host: { verifyUser: () => Promise<boolean> }) =>
		h.runGet
			? h.runGet(host)
			: new Promise((resolve) => {
					h.releaseCeremony = () => resolve({ approved: true, userVerified: true });
				}),
}));

async function load() {
	vi.resetModules();
	h.handlers.clear();
	h.settlePref = undefined;
	h.applied = [];
	h.hookThrows = false;
	h.runGet = undefined;
	h.openedPaths = [];
	h.extensionOnly.clear();
	const mod = await import("./webauthn-provider");
	mod.setProviderApplyHook(async (enabled) => {
		h.applied.push(enabled);
		if (h.hookThrows) throw new Error("attach failed: another extension is attached");
	});
	return mod;
}

/** Drive the settings toggle, as GeneralSection does through the shell. */
const setEnabled = (enabled: boolean) =>
	h.handlers.get("PASSKEY_PROVIDER_SET_ENABLED")?.({ payload: { enabled } });

describe("the provider enabled flag", () => {
	it("defaults to off, because attaching intercepts all browser WebAuthn", async () => {
		const m = await load();
		expect(m.isProviderEnabled()).toBe(false);
	});

	it("enables, runs the apply hook, and disables again", async () => {
		const m = await load();
		await setEnabled(true);
		expect(m.isProviderEnabled()).toBe(true);
		await setEnabled(false);
		expect(m.isProviderEnabled()).toBe(false);
		expect(h.applied).toEqual([true, false]);
	});

	it("keeps an explicit toggle when a slower startup read lands afterwards", async () => {
		// The load is now part of the hydration barrier the router gates dispatch on, so this
		// ordering should not arise; the module refuses it anyway, in case a future caller reads
		// the pref off that path.
		const m = await load();
		const startup = m.loadProviderEnabled(); // read pending

		await setEnabled(true); // user turns it on
		expect(m.isProviderEnabled()).toBe(true);

		h.settlePref?.(false); // the stale read finally lands
		await startup;

		expect(m.isProviderEnabled()).toBe(true); // the user's choice survives
		expect(h.applied).toEqual([true]);
	});

	it("still takes the stored value when the user has not toggled", async () => {
		const m = await load();
		const startup = m.loadProviderEnabled();
		h.settlePref?.(true);
		await startup;
		expect(m.isProviderEnabled()).toBe(true);
	});

	it("rolls the flag back when the apply hook fails", async () => {
		// Chrome's attach() fails outright if another extension holds the proxy. Leaving the flag
		// on would claim we are the provider with nothing attached, and on Firefox that flag alone
		// gates the transport.
		const m = await load();
		h.hookThrows = true;
		await expect(setEnabled(true)).rejects.toThrow(/another extension is attached/);
		expect(m.isProviderEnabled()).toBe(false);
	});

	it("rolls back to the previous value, not to off", async () => {
		const m = await load();
		await setEnabled(true);
		h.hookThrows = true;
		await expect(setEnabled(false)).rejects.toThrow();
		expect(m.isProviderEnabled()).toBe(true);
	});
});

describe("one ceremony at a time", () => {
	const req = { kind: "get" as const, rpId: "example.com", origin: "https://example.com" };

	// The corner card has one slot: a second ceremony used to replace the first's card, leaving the
	// first to auto-decline minutes later.
	it("declines a second ceremony while one is in progress, then serves the next", async () => {
		const m = await load();
		const first = m.depsForTab(1).ceremony(req);
		await Promise.resolve();
		expect(await m.depsForTab(2).ceremony(req)).toEqual({ approved: false });

		h.releaseCeremony?.();
		expect(await first).toEqual({ approved: true, userVerified: true });

		const next = m.depsForTab(1).ceremony(req);
		await Promise.resolve();
		h.releaseCeremony?.();
		expect(await next).toEqual({ approved: true, userVerified: true });
	});
});

describe("confirm it's you", () => {
	const req = { kind: "get" as const, rpId: "example.com", origin: "https://example.com" };
	const flush = () => new Promise((r) => setTimeout(r, 0));

	it("resolves the ceremony from its own verify window's answer, and only from that", async () => {
		const m = await load();
		h.runGet = async (host) => ({ approved: await host.verifyUser() });
		const pending = m.depsForTab(1).ceremony(req);
		await flush();

		expect(h.openedPaths).toHaveLength(1);
		const url = new URL(h.openedPaths[0] ?? "", "chrome-extension://x");
		expect(url.pathname).toBe("/passkey-verify");
		expect(url.searchParams.get("rp")).toBe("example.com");
		const answer = h.handlers.get("PASSKEY_VERIFY_RESULT");
		expect(h.extensionOnly.has(answer)).toBe(true);

		await answer?.({ payload: { id: "someone-else", verified: true } });
		await answer?.({ payload: { id: url.searchParams.get("id"), verified: true } });
		expect(await pending).toEqual({ approved: true });
	});

	it("a no from the window is a no", async () => {
		const m = await load();
		h.runGet = async (host) => ({ approved: await host.verifyUser() });
		const pending = m.depsForTab(1).ceremony(req);
		await flush();
		const id = new URL(h.openedPaths[0] ?? "", "chrome-extension://x").searchParams.get("id");
		await h.handlers.get("PASSKEY_VERIFY_RESULT")?.({ payload: { id, verified: false } });
		expect(await pending).toEqual({ approved: false });
	});
});
