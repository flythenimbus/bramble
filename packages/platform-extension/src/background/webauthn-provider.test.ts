import { describe, expect, it, vi } from "vitest";

// The passkey-provider enabled flag: one in-memory boolean that gates both deliveries (Chrome's
// attach, Firefox's content transport). Two things can leave it disagreeing with reality, and
// both are pinned below as HOLE cases with the fix that will flip them.
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
}));

vi.mock("./prefs", () => ({
	getPasskeyProviderEnabled: () =>
		new Promise<boolean>((resolve) => {
			h.settlePref = resolve;
		}),
}));

vi.mock("./router", () => ({
	on: (type: string, handler: (m: unknown) => Promise<unknown>) => h.handlers.set(type, handler),
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
	savePlacement: async () => {},
}));

vi.mock("./session", () => ({ vaultLocked: () => false }));

vi.mock("./webauthn-proxy", () => ({
	runCreateCeremony: async () => ({ approved: false }),
	runGetCeremony: async () => ({ approved: false }),
}));

async function load() {
	vi.resetModules();
	h.handlers.clear();
	h.settlePref = undefined;
	h.applied = [];
	h.hookThrows = false;
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

	it("HOLE: a slow startup read clobbers a toggle the user made in the meantime", async () => {
		// loadProviderEnabled() is fire-and-forget at background.ts, outside the hydration chain
		// the router gates dispatch on, so a SET_ENABLED can land while the read is still in
		// flight and then be overwritten by the stale stored value. Flip target: F3.
		const m = await load();
		const startup = m.loadProviderEnabled(); // read pending

		await setEnabled(true); // user turns it on
		expect(m.isProviderEnabled()).toBe(true);

		h.settlePref?.(false); // the stale read finally lands
		await startup;

		expect(m.isProviderEnabled()).toBe(false); // the user's explicit choice is gone
		expect(h.applied).toEqual([true]); // ...while the proxy stays attached
	});

	it("HOLE: a failed apply leaves the flag claiming enabled", async () => {
		// The flag is assigned before the hook is awaited and never rolled back, so a failing
		// attach (another extension holds the proxy) leaves the flag on with nothing attached.
		// On Firefox that flag alone gates the content transport. Flip target: F5.
		const m = await load();
		h.hookThrows = true;
		await expect(setEnabled(true)).rejects.toThrow(/another extension is attached/);
		expect(m.isProviderEnabled()).toBe(true);
	});
});
