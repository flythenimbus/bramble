import { afterEach, describe, expect, it, vi } from "vitest";
import { extensionSender, loadBackground, TEST_VEK_KEY } from "./test/test-harness";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe("extensionAutofill session lease", () => {
	it("uses a lease acquired before the index publish", async () => {
		const sendMessage = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, data: { vaultId: "v1", token: "lease" } })
			.mockResolvedValueOnce({ ok: true, data: null });
		vi.stubGlobal("chrome", { runtime: { sendMessage } });
		const { extensionAutofill } = await import("./autofill");

		const lease = await extensionAutofill.beginIndexUpdate?.();
		await Promise.resolve(); // stand in for the caller's blob/decrypt work
		await extensionAutofill.setIndex([], lease);

		expect(sendMessage).toHaveBeenNthCalledWith(1, { type: "AUTOFILL_GET_SESSION_OWNER" });
		expect(sendMessage).toHaveBeenNthCalledWith(2, {
			type: "AUTOFILL_SET_INDEX",
			payload: { entries: [], owner: { vaultId: "v1", token: "lease" } },
		});
	});

	it("clears idempotently after lock when no new lease can be issued", async () => {
		const sendMessage = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, error: "unavailable" })
			.mockResolvedValueOnce({ ok: true, data: null });
		vi.stubGlobal("chrome", { runtime: { sendMessage } });
		const { extensionAutofill } = await import("./autofill");

		await expect(extensionAutofill.clearIndex()).resolves.toBeUndefined();
		expect(sendMessage).toHaveBeenNthCalledWith(2, {
			type: "AUTOFILL_CLEAR_INDEX",
			payload: undefined,
		});
	});

	it("cleans up through the real background adapter path after crypto.lock", async () => {
		const bg = await loadBackground({ sessionSeed: { [TEST_VEK_KEY]: "SEED" } });
		const { extensionAutofill } = await import("./autofill");
		const offscreenSend = bg.chrome.runtime.sendMessage;
		const routeThroughBackground = vi.fn(
			async (message: Record<string, unknown>) => (await bg.send(message, extensionSender)).resp,
		);
		bg.chrome.runtime.sendMessage = routeThroughBackground;
		await extensionAutofill.setIndex([]);
		bg.chrome.runtime.sendMessage = offscreenSend;
		await bg.send({ type: "CRYPTO_LOCK" });
		bg.chrome.runtime.sendMessage = routeThroughBackground;

		await expect(extensionAutofill.clearIndex()).resolves.toBeUndefined();
		expect(
			routeThroughBackground.mock.calls.some(
				([message]) => message.type === "AUTOFILL_CLEAR_INDEX" && message.payload === undefined,
			),
		).toBe(true);
	});
});
