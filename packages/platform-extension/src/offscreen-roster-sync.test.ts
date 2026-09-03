import type { RosterPayload } from "@core/sync/roster";
import { describe, expect, it, vi } from "vitest";

// Regression guard for the sync-never-converges bug. On Chrome the background service worker
// suspends within seconds and restarts on any event — including the storage round-trips sync itself
// sends the offscreen — and it re-sends SYNC_ROSTER_SYNC on every start, because its "already
// running" flag is worker-local. This handler used to obey each one, tearing down live relay +
// WebRTC sessions and rebuilding them, which is longer than discovery and the Noise handshake take.
// The phone would log "synced with <browser>" and then "peer idle — dropping" forever.
// See offscreen-core `syncConfigKey` and docs/p2p-sync.md.

const { started, stub } = vi.hoisted(() => {
	const started: { peerSource: boolean; stopped: boolean }[] = [];
	return { started, stub: {} };
});

vi.mock("./wasm-loader", () => ({ loadWasm: async () => stub }));

vi.mock("@core/sync/transport/roster-sync", () => ({
	startRosterSync: async (opts: { peerSource?: unknown }) => {
		const session = { peerSource: opts.peerSource !== undefined, stopped: false };
		started.push(session);
		return {
			stop: () => {
				session.stopped = true;
			},
			broadcastNow: async () => {},
		};
	},
}));

import { handleHostMessage } from "./offscreen-core";

const roster: RosterPayload = {
	devices: [
		{
			id: "browser",
			publicKey: "browserPub",
			label: "Chrome on Mac",
			addedAt: 0,
			hlc: { wall: 1, counter: 0, node: "browser" },
		},
	],
	revoked: [],
};

const config = (over: Record<string, unknown> = {}) => ({
	relayUrl: "wss://relay.example",
	groupKeyB64: "GROUP",
	roster,
	devicePrivB64: "priv",
	devicePubB64: "pub",
	...over,
});

/** Both transports of one start: the relay mesh and the desktop link. */
const live = () => started.filter((s) => !s.stopped);

async function reset() {
	await handleHostMessage("SYNC_DISCONNECT", null);
	started.length = 0;
}

describe("SYNC_ROSTER_SYNC (a service-worker restart must not restart sync)", () => {
	it("keeps the live sessions when the same config arrives again", async () => {
		await reset();
		await handleHostMessage("SYNC_ROSTER_SYNC", config());
		const first = [...started];
		expect(first).toHaveLength(2);

		// What every service-worker wake sends.
		await handleHostMessage("SYNC_ROSTER_SYNC", config());
		await handleHostMessage("SYNC_ROSTER_SYNC", config());

		expect(started).toHaveLength(2);
		expect(first.some((s) => s.stopped)).toBe(false);
	});

	it("ignores a roster that has changed, since it is read fresh per use", async () => {
		await reset();
		await handleHostMessage("SYNC_ROSTER_SYNC", config());
		// Roster gossip rewrites this constantly; keying on it would restart-loop the sessions
		// doing the gossiping.
		await handleHostMessage(
			"SYNC_ROSTER_SYNC",
			config({
				roster: {
					devices: [
						...roster.devices,
						{
							id: "phone",
							publicKey: "phonePub",
							label: "iPhone",
							addedAt: 1,
							hlc: { wall: 2, counter: 0, node: "phone" },
						},
					],
					revoked: [],
				},
			}),
		);

		expect(started).toHaveLength(2);
	});

	it("restarts when the config actually changes", async () => {
		await reset();
		await handleHostMessage("SYNC_ROSTER_SYNC", config());
		const first = [...started];

		await handleHostMessage("SYNC_ROSTER_SYNC", config({ relayUrl: "wss://other.example" }));

		expect(first.every((s) => s.stopped)).toBe(true);
		expect(live()).toHaveLength(2);
	});

	it("starts again after a disconnect", async () => {
		await reset();
		await handleHostMessage("SYNC_ROSTER_SYNC", config());
		await handleHostMessage("SYNC_DISCONNECT", null);
		expect(live()).toHaveLength(0);

		await handleHostMessage("SYNC_ROSTER_SYNC", config());

		expect(live()).toHaveLength(2);
	});

	it("starts one pair when two arrive at once", async () => {
		await reset();
		// A worker waking twice in quick succession. Both used to pass the running check while the
		// first was still awaiting the wasm, leaving a session nothing held a handle to.
		await Promise.all([
			handleHostMessage("SYNC_ROSTER_SYNC", config()),
			handleHostMessage("SYNC_ROSTER_SYNC", config()),
		]);

		expect(started).toHaveLength(2);
		expect(live()).toHaveLength(2);
		// One relay session and one over the desktop link, not two of either.
		expect(live().filter((s) => s.peerSource)).toHaveLength(1);
	});

	it("leaves nothing running when a disconnect follows a start", async () => {
		await reset();
		await Promise.all([
			handleHostMessage("SYNC_ROSTER_SYNC", config()),
			handleHostMessage("SYNC_DISCONNECT", null),
		]);

		expect(live()).toHaveLength(0);
	});
});
