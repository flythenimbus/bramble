import { beforeEach, describe, expect, it, vi } from "vitest";

// The desktop link is native messaging, and only the Chromium build asks for the permission. The
// section it drives is rendered whenever the platform provides the adapter, so if the adapter
// exists on Firefox the user gets a Connect button whose only possible outcome is an error.

const h = vi.hoisted(() => ({ permissions: ["nativeMessaging"] as string[] | undefined }));

vi.mock("./platform-api", () => ({
	api: {
		runtime: {
			getManifest: () => ({ permissions: h.permissions }),
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
});

describe("extensionDesktopLink", () => {
	it("is available where the manifest asks for native messaging", async () => {
		expect(await load()).toBeDefined();
	});

	it("is absent without the permission, which is what hides the section", async () => {
		// The Firefox manifest: no nativeMessaging, and the desktop app writes no host manifest
		// for it either, so there is nothing at either end to connect to.
		h.permissions = ["storage", "alarms"];

		expect(await load()).toBeUndefined();
	});

	it("is absent rather than throwing when the manifest lists no permissions", async () => {
		h.permissions = undefined;

		expect(await load()).toBeUndefined();
	});
});
