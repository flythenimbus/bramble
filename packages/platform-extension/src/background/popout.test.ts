import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBackground, pageSender } from "./test-harness";

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
