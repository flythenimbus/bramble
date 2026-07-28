import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type BackgroundHarness,
	extensionSender,
	loadBackground,
	pageSender,
	TEST_VEK_KEY,
} from "../test/test-harness";

afterEach(() => {
	vi.unstubAllGlobals();
});

const HANDOFF_KEY = "popout.handoff";
const UNLOCK_WINDOW_KEY = "popout.unlockWindowId";
const CORNER_HANDOFF_KEY = "cornerPrompt.handoff";

describe("POPOUT_OPEN", () => {
	it("stashes the handoff before creating the detached window", async () => {
		const bg = await loadBackground();
		const { resp } = await bg.send(
			{ type: "POPOUT_OPEN", payload: { handoff: { draft: "x" } } },
			pageSender("example.com", 4),
		);
		expect(resp).toEqual({ ok: true });
		expect(bg.state.session[HANDOFF_KEY]).toEqual({ draft: "x" });
		expect(bg.state.windowsCreated).toHaveLength(1);
		expect(bg.state.windowsCreated[0]?.url).toContain("popup.html?detached=1");
	});

	it("clears any stale handoff when none is supplied", async () => {
		const bg = await loadBackground({ sessionSeed: { [HANDOFF_KEY]: { stale: true } } });
		await bg.send({ type: "POPOUT_OPEN", payload: {} }, pageSender("example.com", 4));
		expect(bg.state.session[HANDOFF_KEY]).toBeUndefined();
		expect(bg.state.windowsCreated).toHaveLength(1);
	});

	it("focuses the open pop-out instead of opening a second one", async () => {
		const bg = await loadBackground();
		await bg.send({ type: "POPOUT_OPEN", payload: {} }, pageSender("example.com", 4));
		expect(bg.state.windowsCreated).toHaveLength(1);
		// windows.create returns id 999; the second request should find and focus it.
		const { resp } = await bg.send(
			{ type: "POPOUT_OPEN", payload: {} },
			pageSender("example.com", 4),
		);
		expect(resp).toEqual({ ok: true });
		expect(bg.state.windowsCreated).toHaveLength(1); // no duplicate
		expect(bg.chrome.windows.update).toHaveBeenCalledWith(
			999,
			expect.objectContaining({ focused: true }),
		);
	});

	it("opens a fresh window when the tracked one was closed while the worker slept", async () => {
		const bg = await loadBackground();
		await bg.send({ type: "POPOUT_OPEN", payload: {} }, pageSender("example.com", 4));
		expect(bg.state.windowsCreated).toHaveLength(1);
		// The tracked window no longer exists: windows.get now rejects for every id.
		bg.chrome.windows.get = vi.fn(async () => {
			throw new Error("No window with id 999");
		});
		await bg.send({ type: "POPOUT_OPEN", payload: {} }, pageSender("example.com", 4));
		expect(bg.state.windowsCreated).toHaveLength(2);
	});

	it("opens a fresh window for a draft handoff even when one is already open", async () => {
		const bg = await loadBackground();
		await bg.send({ type: "POPOUT_OPEN", payload: {} }, pageSender("example.com", 4));
		expect(bg.state.windowsCreated).toHaveLength(1);
		// A draft would be lost if we focused the already-booted window, so a new one opens.
		const { resp } = await bg.send(
			{
				type: "POPOUT_OPEN",
				payload: { handoff: { path: "/vault/new", draft: { pw: "s3cret" } } },
			},
			pageSender("example.com", 4),
		);
		expect(resp).toEqual({ ok: true });
		expect(bg.state.windowsCreated).toHaveLength(2);
		expect(bg.state.session[HANDOFF_KEY]).toEqual({ path: "/vault/new", draft: { pw: "s3cret" } });
	});

	it("falls back to an unpositioned window when Chrome rejects the bounds", async () => {
		// Anchored beside a window near the screen edge, the computed bounds can land off-screen and
		// Chrome rejects the whole create ("must be at least 50% within visible screen space"),
		// which silently took the pop-out down with it. Retry without them.
		const bg = await loadBackground();
		let first = true;
		bg.chrome.windows.create = vi.fn(async (opts: Record<string, unknown>) => {
			bg.state.windowsCreated.push(opts);
			if (first) {
				first = false;
				throw new Error("Invalid value for bounds.");
			}
			return { id: 999 };
		});
		await bg.send({ type: "POPOUT_OPEN", payload: {} }, pageSender("example.com", 4));
		expect(bg.state.windowsCreated).toHaveLength(2);
		expect(bg.state.windowsCreated[1]).not.toHaveProperty("left");
		expect(bg.state.session["popout.windowId"]).toBe(999);
	});

	it("focuses (does not duplicate) a route-only handoff with no draft", async () => {
		const bg = await loadBackground();
		await bg.send(
			{ type: "POPOUT_OPEN", payload: { handoff: { path: "/vault" } } },
			pageSender("example.com", 4),
		);
		expect(bg.state.windowsCreated).toHaveLength(1);
		await bg.send(
			{ type: "POPOUT_OPEN", payload: { handoff: { path: "/settings" } } },
			pageSender("example.com", 4),
		);
		expect(bg.state.windowsCreated).toHaveLength(1); // route-only: safe to focus existing
	});
});

describe("the unlock pop-out closes itself once the vault opens", () => {
	/** Open the picker's unlock pop-out (window 999), then unlock the vault. */
	async function unlockViaPopout(bg: BackgroundHarness): Promise<void> {
		await bg.send(
			{ type: "POPOUT_OPEN", payload: { reason: "unlock" } },
			pageSender("example.com", 4),
		);
		expect(bg.state.session[UNLOCK_WINDOW_KEY]).toBe(999);
		await bg.send({ type: "CRYPTO_UNWRAP_PASSWORD_SLOT", payload: {} }, extensionSender);
		await bg.flush();
	}

	it("closes the window it opened for the unlock, and forgets it", async () => {
		const bg = await loadBackground();
		await unlockViaPopout(bg);
		expect(bg.state.windowsRemoved).toEqual([999]);
		expect(bg.state.session[UNLOCK_WINDOW_KEY]).toBeUndefined();
		// The tracked pop-out is gone too, so the next request opens a fresh window.
		expect(bg.state.session["popout.windowId"]).toBeUndefined();
	});

	it("leaves a pop-out the user opened themselves alone", async () => {
		const bg = await loadBackground();
		await bg.send({ type: "POPOUT_OPEN", payload: {} }, pageSender("example.com", 4));
		await bg.send({ type: "CRYPTO_UNWRAP_PASSWORD_SLOT", payload: {} }, extensionSender);
		await bg.flush();
		expect(bg.state.windowsRemoved).toEqual([]);
	});

	it("stays open under Immediate auto-lock, where closing it would re-lock the vault", async () => {
		const bg = await loadBackground({ localSeed: { "pref.autoLockMinutes": -1 } });
		await unlockViaPopout(bg);
		expect(bg.state.windowsRemoved).toEqual([]);
	});

	it("stays open while a corner capture is parked, so the view can still flush it", async () => {
		const bg = await loadBackground({
			sessionSeed: { [CORNER_HANDOFF_KEY]: { intent: "save" } },
		});
		await unlockViaPopout(bg);
		expect(bg.state.windowsRemoved).toEqual([]);
	});

	it("does not close anything on a lock", async () => {
		const bg = await loadBackground({ sessionSeed: { [TEST_VEK_KEY]: "SEED" } });
		await bg.send(
			{ type: "POPOUT_OPEN", payload: { reason: "unlock" } },
			pageSender("example.com", 4),
		);
		await bg.send({ type: "CRYPTO_LOCK" }, extensionSender);
		await bg.flush();
		expect(bg.state.windowsRemoved).toEqual([]);
	});
});

describe("POPOUT_CONSUME_HANDOFF", () => {
	it("returns the stashed handoff and deletes it (one-shot)", async () => {
		const bg = await loadBackground({ sessionSeed: { [HANDOFF_KEY]: { draft: "y" } } });
		const first = await bg.send({ type: "POPOUT_CONSUME_HANDOFF" });
		expect(first.resp).toEqual({ ok: true, data: { draft: "y" } });
		expect(bg.state.session[HANDOFF_KEY]).toBeUndefined();
		// A reload re-reads nothing.
		const second = await bg.send({ type: "POPOUT_CONSUME_HANDOFF" });
		expect(second.resp).toEqual({ ok: true, data: null });
	});
});
