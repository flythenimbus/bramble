import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearAutofillIndex,
	extensionSender,
	loadBackground,
	pageSender,
	setAutofillIndex,
	TEST_VEK_KEY,
} from "../test/test-harness";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("router dispatch", () => {
	it("ignores messages targeted at the offscreen document", async () => {
		const bg = await loadBackground();
		const { handled } = await bg.send({ target: "offscreen", type: "CRYPTO_LOCK" });
		expect(handled).toBe(false);
	});

	it("ignores unknown message types", async () => {
		const bg = await loadBackground();
		expect((await bg.send({ type: "NOPE_UNKNOWN" })).handled).toBe(false);
		expect((await bg.send({})).handled).toBe(false);
		expect((await bg.send({ type: undefined })).handled).toBe(false);
	});

	it("dispatches a registered exact handler and wraps the envelope", async () => {
		const bg = await loadBackground({ sessionSeed: { [TEST_VEK_KEY]: "SEED" } });
		const { handled, resp } = await clearAutofillIndex(bg);
		expect(handled).toBe(true);
		expect(resp).toEqual({ ok: true, data: null });
	});

	it("routes the CRYPTO_ prefix to the dedicated handler and returns the raw offscreen envelope", async () => {
		const bg = await loadBackground({ sessionSeed: { [TEST_VEK_KEY]: "SEED" } });
		await setAutofillIndex(bg, []);
		const { handled, resp } = await bg.send({ type: "CRYPTO_GENERATE_VEK" });
		expect(handled).toBe(true);
		// Raw offscreen envelope, NOT re-wrapped as { ok: true, data: { ok, data } }.
		expect(resp).toEqual({ ok: true, data: "VEK_GENERATED" });
	});

	it("wraps a thrown handler error as { ok: false, error: String(err) }", async () => {
		const bg = await loadBackground({ sessionSeed: { [TEST_VEK_KEY]: "SEED" } });
		await setAutofillIndex(bg, []);
		const { resp } = await bg.send(
			{ type: "AUTOFILL_FETCH", payload: { entryId: "missing" } },
			extensionSender,
		);
		expect(resp.ok).toBe(false);
		expect(resp.error).toBe("Error: entry not found: missing");
	});

	// A3: privileged crypto/sync handlers must reject content-script senders. A content
	// script that reaches the SW router (e.g. via a relay bug) must not drive CRYPTO_* or
	// SYNC_*. See docs/sec-audit-7726.md (A3).
	it("rejects CRYPTO_* from a content-script sender", async () => {
		const bg = await loadBackground();
		const { handled, resp } = await bg.send(
			{ type: "CRYPTO_GENERATE_VEK" },
			pageSender("example.com", 3),
		);
		expect(handled).toBe(true);
		expect(resp).toEqual({ ok: false, error: "forbidden" });
	});

	it("allows CRYPTO_* from an extension-context sender", async () => {
		const bg = await loadBackground();
		const { resp } = await bg.send({ type: "CRYPTO_GENERATE_VEK" }, extensionSender);
		expect(resp).toEqual({ ok: true, data: "VEK_GENERATED" });
	});

	it("rejects SYNC_* from a content-script sender", async () => {
		const bg = await loadBackground();
		for (const type of ["SYNC_LOCAL_PAYLOAD", "SYNC_DEVICE_PUBKEY", "SYNC_APPLY_ROSTER"]) {
			const { resp } = await bg.send({ type, payload: {} }, pageSender("example.com", 3));
			expect(resp).toEqual({ ok: false, error: "forbidden" });
		}
	});

	it("awaits hydration before running handlers (seeded VEK is visible)", async () => {
		// Seed an unlocked session; AUTOFILL_QUERY should schedule the auto-lock
		// alarm only when unlocked, proving hydration completed first.
		const bg = await loadBackground({ sessionSeed: { [TEST_VEK_KEY]: "SEED" } });
		await setAutofillIndex(bg, []);
		const before = { ...bg.state.alarms };
		await bg.send(
			{ type: "AUTOFILL_QUERY", hasLogin: true },
			{ origin: "https://example.com", url: "https://example.com/login", tab: { id: 3 } },
		);
		expect("vault:autolock" in bg.state.alarms).toBe(true);
		expect("vault:autolock" in before).toBe(true); // SET_INDEX already scheduled it
	});
});

// The pre-dispatch hook exists so a lock transition starts before the router awaits hydration.
// session.ts takes depth-counted state there that only the HANDLER's `finally` releases, so any
// path that runs the hook but skips the handler strands that state for the worker's lifetime and
// silently disables autofill (autofillSessionIsStable stays false) until a restart.
describe("router pre-dispatch safety", () => {
	async function loadRouter() {
		vi.resetModules();
		let listener:
			| ((message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown)
			| undefined;
		vi.stubGlobal("chrome", {
			runtime: {
				// sender.ts computes the extension origin at import time.
				getURL: (path: string) => `chrome-extension://router-test/${path}`,
				onMessage: { addListener: (fn: typeof listener) => (listener = fn) },
			},
		});
		const router = await import("./router");
		return { router, dispatch: () => listener };
	}

	it("still runs the handler when the hydration promise rejects", async () => {
		const { router, dispatch } = await loadRouter();
		router.setReady(Promise.reject(new Error("hydration exploded")));
		const handler = vi.fn(async () => ({ ok: true as const, data: null }));
		router.on("PROBE", handler);

		const responded = new Promise((resolve) => {
			dispatch()?.({ type: "PROBE" }, {}, resolve);
		});
		await expect(responded).resolves.toEqual({ ok: true, data: null });
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("dispatches even when a pre-dispatch hook throws", async () => {
		const { router, dispatch } = await loadRouter();
		router.setReady(Promise.resolve());
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		router.onBeforeDispatch(() => {
			throw new Error("hook exploded");
		});
		const handler = vi.fn(async () => ({ ok: true as const, data: null }));
		router.on("PROBE", handler);

		let keptChannelOpen: unknown;
		const responded = new Promise((resolve) => {
			keptChannelOpen = dispatch()?.({ type: "PROBE" }, {}, resolve);
		});
		// `true` is what keeps the one-shot response channel open; a thrown hook must not lose it.
		expect(keptChannelOpen).toBe(true);
		await expect(responded).resolves.toEqual({ ok: true, data: null });
		expect(handler).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});
});
