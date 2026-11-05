// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createAppRouter, persistableHref } from "./router";

async function loaded(initialPath: string, isLocked = false) {
	const router = createAppRouter(initialPath);
	router.update({
		context: {
			vault: { isLocked, ready: true, entries: [], unlockedWithRecoveryCode: false },
			registry: undefined,
		},
	});
	await router.load();
	return router;
}

describe("persistableHref", () => {
	it("keeps a normal route for the next view to reopen", async () => {
		expect(persistableHref(await loaded("/settings"))).toBe("/settings");
	});

	it("skips the unlock screen", async () => {
		expect(persistableHref(await loaded("/", true))).toBeNull();
	});

	// #187: the toolbar popup reopened a finished confirm and looped on it.
	it("never keeps the passkey confirm, a one-shot window", async () => {
		const router = await loaded("/passkey-verify?id=req-1&rp=github.com");
		expect(router.state.location.pathname).toBe("/passkey-verify");
		expect(persistableHref(router)).toBeNull();
	});
});
