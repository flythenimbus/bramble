import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBackground, pageSender } from "../test/test-harness";

afterEach(() => vi.unstubAllGlobals());

describe("known hostname cold-wake cap", () => {
	it("trims 6000 persisted hints to the newest 1000 before serving locked queries", async () => {
		const hosts = Array.from({ length: 6000 }, (_, i) => `site${i}.com`);
		const bg = await loadBackground({ localSeed: { "autofill.knownHostnames": hosts } });
		const old = await bg.send(
			{ type: "AUTOFILL_QUERY", hasLogin: true },
			pageSender("site0.com", 4),
		);
		const recent = await bg.send(
			{ type: "AUTOFILL_QUERY", hasLogin: true },
			pageSender("site5999.com", 5),
		);
		expect(old.resp.data.hasPotentialMatch).toBe(false);
		expect(recent.resp.data.hasPotentialMatch).toBe(true);
		expect(bg.state.local["autofill.knownHostnames"]).toEqual(hosts.slice(-1000));
	});
});
