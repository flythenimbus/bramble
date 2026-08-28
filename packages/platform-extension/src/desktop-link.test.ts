import { beforeEach, describe, expect, it, vi } from "vitest";

// The desktop link is native messaging, and only the Chromium build declares the permission. The
// section it drives is rendered whenever the platform provides the adapter, so if the adapter
// exists on Firefox the user gets a Connect button whose only possible outcome is an error.
//
// Chromium declares it OPTIONAL and asks at connect time, so both arrays have to count: gating on
// `permissions` alone would hide the section on the very build the feature ships on.

const h = vi.hoisted(() => ({
	permissions: ["nativeMessaging"] as string[] | undefined,
	optional: undefined as string[] | undefined,
	held: false,
	/** Every permissions call, so the tests can assert what was asked for, not just that it ran. */
	calls: [] as { fn: string; arg: unknown }[],
}));

// Deliberately no `connectNative` on this mock: the gate must not test for the binding, which is
// stale in both directions across a grant or a revoke.
vi.mock("./platform-api", () => ({
	api: {
		runtime: {
			getManifest: () => ({ permissions: h.permissions, optional_permissions: h.optional }),
			sendMessage: async () => ({ ok: true }),
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
