import { describe, expect, it, vi } from "vitest";
import type { Channel } from "./channel";
import { reapStale } from "./roster-sync";

const fakeChannel: Channel = { send: () => {}, recv: () => new Promise<string>(() => {}) };

describe("reapStale", () => {
	it("drops peers silent past the stale window and keeps fresh ones", () => {
		const now = 1_000_000;
		const staleClose = vi.fn();
		const freshClose = vi.fn();
		const peers = new Map([
			[
				"staleaaaa",
				{ channel: fakeChannel, sessionId: 1, lastSeen: now - 60_000, close: staleClose },
			],
			[
				"freshbbbb",
				{ channel: fakeChannel, sessionId: 2, lastSeen: now - 1_000, close: freshClose },
			],
		]);

		reapStale({ report: () => {} }, peers, now);

		expect(peers.has("staleaaaa")).toBe(false);
		expect(peers.has("freshbbbb")).toBe(true);
		expect(staleClose).toHaveBeenCalledOnce();
		expect(freshClose).not.toHaveBeenCalled();
	});
});
