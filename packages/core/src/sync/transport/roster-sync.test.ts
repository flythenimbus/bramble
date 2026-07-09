import { describe, expect, it, vi } from "vitest";
import { encodeRoster, type RosterPayload } from "..";
import type { Channel } from "./channel";
import { currentRoster, reapRevoked, reapStale } from "./roster-sync";

const fakeChannel: Channel = { send: () => {}, recv: () => new Promise<string>(() => {}) };

/** A roster whose active devices carry the given public keys. */
const rosterWith = (pubkeys: string[]): RosterPayload => ({
	devices: pubkeys.map((pk, i) => ({
		id: `d${i}`,
		publicKey: pk,
		label: `d${i}`,
		addedAt: 0,
		hlc: { wall: i, counter: 0, node: `d${i}` },
	})),
	revoked: [],
});

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

describe("currentRoster (revocation takes effect on a live session)", () => {
	it("reads the roster fresh from fetchLocalRoster, not the frozen snapshot", async () => {
		const stale = rosterWith(["revokedpk", "activepk"]);
		const fresh = rosterWith(["activepk"]); // revokedpk has since been removed
		const r = await currentRoster({
			roster: stale,
			fetchLocalRoster: async () => encodeRoster(fresh),
		});
		expect(r.devices.map((d) => d.publicKey)).toEqual(["activepk"]);
	});

	it("falls back to the initial snapshot when fetchLocalRoster is absent or unparseable", async () => {
		const snap = rosterWith(["snappk"]);
		expect(await currentRoster({ roster: snap })).toEqual(snap);
		expect(await currentRoster({ roster: snap, fetchLocalRoster: async () => "" })).toEqual(snap);
	});
});

describe("reapRevoked", () => {
	it("closes and drops a peer no longer in the current roster; keeps active members", () => {
		const revokedClose = vi.fn();
		const activeClose = vi.fn();
		const peers = new Map([
			["revokedpk", { channel: fakeChannel, sessionId: 1, lastSeen: 0, close: revokedClose }],
			["activepk", { channel: fakeChannel, sessionId: 2, lastSeen: 0, close: activeClose }],
		]);

		reapRevoked({ report: () => {} }, peers, rosterWith(["activepk"]));

		expect(peers.has("revokedpk")).toBe(false);
		expect(peers.has("activepk")).toBe(true);
		expect(revokedClose).toHaveBeenCalledOnce();
		expect(activeClose).not.toHaveBeenCalled();
	});
});
