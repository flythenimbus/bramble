import { afterEach, describe, expect, it, vi } from "vitest";
import { extensionSender, loadBackground, pageSender } from "../test/test-harness";

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
		const bg = await loadBackground();
		const { handled, resp } = await bg.send({ type: "AUTOFILL_CLEAR_INDEX" });
		expect(handled).toBe(true);
		expect(resp).toEqual({ ok: true, data: null });
	});

	it("routes the CRYPTO_ prefix to the dedicated handler and returns the raw offscreen envelope", async () => {
		const bg = await loadBackground();
		const { handled, resp } = await bg.send({ type: "CRYPTO_GENERATE_VEK" });
		expect(handled).toBe(true);
		// Raw offscreen envelope, NOT re-wrapped as { ok: true, data: { ok, data } }.
		expect(resp).toEqual({ ok: true, data: "VEK_GENERATED" });
	});

	it("wraps a thrown handler error as { ok: false, error: String(err) }", async () => {
		// AUTOFILL_FETCH from an extension page while locked -> fetchFill throws.
		const bg = await loadBackground();
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
		const bg = await loadBackground({ sessionSeed: { "vault.vek": "SEED" } });
		await bg.send({ type: "AUTOFILL_SET_INDEX", payload: [] }, extensionSender);
		const before = { ...bg.state.alarms };
		await bg.send(
			{ type: "AUTOFILL_QUERY", hasLogin: true },
			{ origin: "https://example.com", url: "https://example.com/login", tab: { id: 3 } },
		);
		expect("vault:autolock" in bg.state.alarms).toBe(true);
		expect("vault:autolock" in before).toBe(true); // SET_INDEX already scheduled it
	});
});
