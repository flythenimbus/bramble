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
}));

// Deliberately no `connectNative` on this mock: the gate must not test for the binding, which is
// stale in both directions across a grant or a revoke.
vi.mock("./platform-api", () => ({
	api: {
		runtime: {
			getManifest: () => ({ permissions: h.permissions, optional_permissions: h.optional }),
			sendMessage: async () => ({ ok: true }),
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
});

describe("extensionDesktopLink", () => {
	it("is available where the manifest requires native messaging", async () => {
		expect(await load()).toBeDefined();
	});

	it("is available where the manifest only asks for it optionally", async () => {
		// The shipping Chromium manifest. The permission is requested when the user clicks
		// Connect, so at load time it is declared but not held, and the section still has to
		// render or there is nowhere to grant it from.
		h.permissions = ["storage", "alarms"];
		h.optional = ["nativeMessaging"];

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
