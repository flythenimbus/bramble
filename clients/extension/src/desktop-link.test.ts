import { beforeEach, describe, expect, it, vi } from "vitest";

// The desktop link is native messaging. The section it drives is rendered whenever the platform
// provides the adapter, so if the adapter exists on a build that cannot declare the permission the
// user gets a Connect button whose only possible outcome is an error.
//
// Both builds declare it OPTIONAL and ask at connect time, so both arrays have to count: gating on
// `permissions` alone would hide the section on the very builds the feature ships on.

const h = vi.hoisted(() => ({
	permissions: ["nativeMessaging"] as string[] | undefined,
	optional: undefined as string[] | undefined,
	held: false,
	/** Every permissions call, so the tests can assert what was asked for, not just that it ran. */
	calls: [] as { fn: string; arg: unknown }[],
	/** What the background answers every message with. */
	reply: { ok: true } as { ok: boolean; error?: string; data?: unknown },
	/** Whether this page has the connectNative binding, so it can lend the background a pipe. */
	binding: false,
	/** Every message sent to the background, in order. */
	sent: [] as Record<string, unknown>[],
	/** The relay ports this page opened to lend a pipe, by name. */
	relays: [] as string[],
	/** How many lent relay ports this page closed. */
	relaysClosed: 0,
	/** Whether the background says it cannot open a pipe of its own. */
	needed: true,
}));

// No `connectNative` on this mock unless a case turns the binding on: the gate must not test for
// it, which is stale in both directions across a grant or a revoke.
vi.mock("./platform-api", () => ({
	api: {
		runtime: {
			getManifest: () => ({ permissions: h.permissions, optional_permissions: h.optional }),
			sendMessage: async (msg: Record<string, unknown>) => {
				h.sent.push(msg);
				// Asked before lending; the background cannot open its own pipe here.
				if (msg.type === "DESKTOP_LINK_TRANSPORT_NEEDED") return { ok: true, data: h.needed };
				return h.reply;
			},
			get connectNative() {
				if (!h.binding) return undefined;
				return () => ({
					postMessage: () => {},
					onMessage: { addListener: () => {} },
					onDisconnect: { addListener: () => {} },
					disconnect: () => {},
				});
			},
			connect: ({ name }: { name: string }) => {
				h.relays.push(name);
				return {
					postMessage: () => {},
					// The background acks a lent port as soon as it registers it.
					onMessage: {
						addListener: (cb: (m: unknown) => void) => queueMicrotask(() => cb({ ready: true })),
					},
					disconnect: () => {
						h.relaysClosed++;
					},
				};
			},
		},
		permissions: {
			contains: async (arg: unknown) => {
				h.calls.push({ fn: "contains", arg });
				return h.held;
			},
			request: async (arg: unknown) => {
				h.calls.push({ fn: "request", arg });
				h.held = true;
				return true;
			},
			remove: async (arg: unknown) => {
				h.calls.push({ fn: "remove", arg });
				h.held = false;
				return true;
			},
		},
	},
}));

/** Re-imported per case, because the manifest is read once when the module loads. */
async function load() {
	vi.resetModules();
	return (await import("./desktop-link")).extensionDesktopLink;
}

beforeEach(() => {
	h.permissions = ["nativeMessaging"];
	h.optional = undefined;
	h.held = false;
	h.calls = [];
	h.reply = { ok: true };
	h.binding = false;
	h.sent = [];
	h.relays = [];
	h.relaysClosed = 0;
	h.needed = true;
});

/** The shipping Chromium manifest: declared optional, so it is asked for at connect time. */
const asOptional = () => {
	h.permissions = ["storage", "alarms"];
	h.optional = ["nativeMessaging"];
};

describe("extensionDesktopLink", () => {
	it("is available where the manifest requires native messaging", async () => {
		expect(await load()).toBeDefined();
	});

	it("is available where the manifest only asks for it optionally", async () => {
		// The permission is requested when the user clicks Connect, so at load time it is declared
		// but not held, and the section still has to render or there is nowhere to grant it from.
		asOptional();

		expect(await load()).toBeDefined();
	});

	it("is absent without the permission, which is what hides the section", async () => {
		// The Firefox manifest: no nativeMessaging in either array, and the desktop app writes no
		// host manifest for it either, so there is nothing at either end to connect to.
		h.permissions = ["storage", "alarms"];

		expect(await load()).toBeUndefined();
	});

	it("is absent when the optional array exists but does not name it", async () => {
		h.permissions = ["storage"];
		h.optional = ["clipboardWrite"];

		expect(await load()).toBeUndefined();
	});

	it("is absent rather than throwing when the manifest lists no permissions", async () => {
		h.permissions = undefined;

		expect(await load()).toBeUndefined();
	});
});

describe("the permission sub-adapter", () => {
	it("is offered where the permission is optional", async () => {
		asOptional();

		expect((await load())?.permission).toBeDefined();
	});

	it("is withheld where the permission is required, which reads as already-allowed", async () => {
		// Nothing to ask for and nothing to give back: permissions.remove refuses a required
		// permission, so offering drop() here would be a control that silently does nothing.
		expect((await load())?.permission).toBeUndefined();
	});

	it("reports what the browser holds rather than what the manifest declares", async () => {
		asOptional();
		const link = await load();

		expect(await link?.permission?.granted()).toBe(false);
		h.held = true;
		expect(await link?.permission?.granted()).toBe(true);
	});

	it("asks for nativeMessaging alone, not the whole manifest", async () => {
		asOptional();
		const link = await load();

		expect(await link?.permission?.request()).toBe(true);
		// A request naming more than it needs would widen the prompt the user is shown, which is
		// the opposite of why any of this exists.
		expect(h.calls).toContainEqual({ fn: "request", arg: { permissions: ["nativeMessaging"] } });
	});

	it("hands the permission back on drop", async () => {
		asOptional();
		const link = await load();
		await link?.permission?.request();

		await link?.permission?.drop();

		expect(await link?.permission?.granted()).toBe(false);
		expect(h.calls).toContainEqual({ fn: "remove", arg: { permissions: ["nativeMessaging"] } });
	});

	it("never consults the API binding to decide whether it is held", async () => {
		// The mocked runtime has no connectNative at all. If granted() ever reached for it this
		// would throw rather than answer, which is the point: the binding is stale in both
		// directions and is not evidence of anything.
		asOptional();
		const link = await load();

		await expect(link?.permission?.granted()).resolves.toBe(false);
		expect(h.calls).toEqual([{ fn: "contains", arg: { permissions: ["nativeMessaging"] } }]);
	});
});

describe("a failure the background reports", () => {
	it("reads as the background's words, without the prefix its router adds", async () => {
		// The router sends back String(err), so every refusal reached the screen as "Error: ...".
		h.reply = { ok: false, error: "Error: The desktop app did not approve the link." };
		const link = await load();

		await expect(link?.confirm?.("L1", true)).rejects.toThrow(
			/^The desktop app did not approve the link\.$/,
		);
	});
});

// The app reads a connection as one session. Settings asks for the app's key while the link flow
// asks for its vault, and on one shared pipe the second hello broke the first: no invite came.
describe("a pipe lent to the background", () => {
	/** The lent pipe each request named, as the relay port name it would match. */
	const named = (type: string) =>
		h.sent.filter((m) => m.type === type).map((m) => `link-native-proxy:${String(m.via)}`);

	it("is its own for each request, even when two run at once", async () => {
		h.binding = true;
		h.reply = { ok: true, data: null };
		const link = await load();

		await Promise.all([link?.vaultSummary?.(), link?.desktopSyncKey?.()]);

		expect(new Set(h.relays).size).toBe(2);
		expect([...named("DESKTOP_LINK_VAULT_SUMMARY"), ...named("DESKTOP_LINK_SYNC_KEY")]).toEqual(
			expect.arrayContaining(h.relays),
		);
	});

	it("is named by the emoji link's start, which keeps it until the answer", async () => {
		h.binding = true;
		h.reply = { ok: true, data: { legacy: true } };
		const link = await load();

		await link?.start?.();

		expect(named("DESKTOP_LINK_START")).toEqual(h.relays);
	});

	it("is lent for the emoji link even to a background with a pipe of its own", async () => {
		// The link in progress then lives exactly as long as this page, which runs its vault copy:
		// the app forgets its half when the page closes, and so does the background.
		h.binding = true;
		h.needed = false;
		h.reply = { ok: true, data: { id: "L1", sas: { emoji: [], digits: "" } } };
		const link = await load();

		await link?.start?.();

		expect(h.relays).toHaveLength(1);
		expect(named("DESKTOP_LINK_START")).toEqual(h.relays);
	});
});

// A pairing ends with the link attached to a vault, or with nothing kept on either side.
describe("a link per vault", () => {
	const sentTypes = () =>
		h.sent.filter((m) => m.type !== "DESKTOP_LINK_TRANSPORT_NEEDED").map((m) => ({ ...m }));

	it("attaches the link to the vault the flow ended in", async () => {
		h.reply = { ok: true, data: true };
		const link = await load();

		await expect(link?.attach?.("v2")).resolves.toBe(true);
		expect(sentTypes()).toEqual([{ type: "DESKTOP_LINK_ATTACH", vaultId: "v2" }]);
	});

	it("lets a link go, closing the pipe this page lent for it", async () => {
		h.binding = true;
		h.reply = { ok: true, data: { id: "L1", sas: { emoji: [], digits: "" } } };
		const link = await load();
		await link?.start?.();
		await link?.confirm?.("L1", true);
		expect(h.relaysClosed).toBe(0);

		await link?.abandon?.();

		expect(sentTypes().at(-1)).toEqual({ type: "DESKTOP_LINK_ABANDON" });
		expect(h.relaysClosed).toBe(1);
	});

	it("asks the background to forget a deleted vault's link", async () => {
		h.reply = { ok: true };
		const link = await load();

		await link?.forgetVault?.("v3");

		expect(sentTypes()).toEqual([{ type: "DESKTOP_LINK_FORGET_VAULT", vaultId: "v3" }]);
	});

	it("says how many vaults still have a link after one is disconnected", async () => {
		h.reply = { ok: true, data: { remaining: 1 } };
		const link = await load();

		await expect(link?.unlink()).resolves.toEqual({ remaining: 1 });
	});
});
