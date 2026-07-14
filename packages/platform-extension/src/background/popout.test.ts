import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBackground, pageSender } from "../test/test-harness";

afterEach(() => {
	vi.unstubAllGlobals();
});

const HANDOFF_KEY = "popout.handoff";

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
