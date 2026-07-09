import { describe, expect, it } from "vitest";
import { HLC_MAX_DRIFT_MS, type Hlc } from "./hlc";
import {
	activeDevices,
	addDevice,
	decodeRoster,
	emptyRoster,
	encodeRoster,
	findDevice,
	isActiveDevice,
	mergeRemoteRoster,
	mergeRosters,
	type RosterEntry,
	type RosterPayload,
	revokeDevice,
	sanitizeRemoteRoster,
} from "./roster";

const hlc = (wall: number, node: string): Hlc => ({ wall, counter: 0, node });
const device = (id: string, wall: number, label = id): RosterEntry => ({
	id,
	publicKey: `pk-${id}`,
	label,
	addedAt: wall,
	hlc: hlc(wall, id),
});

const ids = (r: RosterPayload) =>
	activeDevices(r)
		.map((d) => d.id)
		.sort();

describe("roster add/revoke", () => {
	it("adds devices", () => {
		let r = emptyRoster();
		r = addDevice(r, device("laptop", 100));
		r = addDevice(r, device("phone", 200));
		expect(ids(r)).toEqual(["laptop", "phone"]);
		expect(isActiveDevice(r, "phone")).toBe(true);
		expect(findDevice(r, "laptop")?.publicKey).toBe("pk-laptop");
	});

	it("revokes a device so it is no longer active", () => {
		let r = addDevice(emptyRoster(), device("phone", 100));
		r = revokeDevice(r, "phone", hlc(200, "laptop"));
		expect(ids(r)).toEqual([]);
		expect(isActiveDevice(r, "phone")).toBe(false);
	});

	it("does not let a stale copy of a revoked device resurrect it", () => {
		let r = addDevice(emptyRoster(), device("phone", 100));
		r = revokeDevice(r, "phone", hlc(300, "laptop"));
		const stale = addDevice(emptyRoster(), device("phone", 100));
		expect(ids(mergeRosters(r, stale))).toEqual([]);
		expect(ids(mergeRosters(stale, r))).toEqual([]);
	});

	it("re-enrolling with a newer stamp brings a device back", () => {
		let r = addDevice(emptyRoster(), device("phone", 100));
		r = revokeDevice(r, "phone", hlc(200, "laptop"));
		r = addDevice(r, device("phone", 300));
		expect(ids(r)).toEqual(["phone"]);
	});
});

describe("roster merge", () => {
	it("converges regardless of order", () => {
		const a = addDevice(addDevice(emptyRoster(), device("laptop", 100)), device("phone", 150));
		const b = revokeDevice(addDevice(emptyRoster(), device("tablet", 120)), "phone", hlc(300, "x"));
		expect(ids(mergeRosters(a, b))).toEqual(ids(mergeRosters(b, a)));
		// phone revoked at 300 > added at 150; laptop + tablet remain.
		expect(ids(mergeRosters(a, b))).toEqual(["laptop", "tablet"]);
	});
});

describe("roster codec", () => {
	it("round-trips", () => {
		let r = addDevice(emptyRoster(), device("laptop", 100));
		r = revokeDevice(r, "old", hlc(50, "x"));
		expect(decodeRoster(encodeRoster(r))).toEqual(r);
	});

	it("rejects a malformed roster", () => {
		expect(() => decodeRoster(JSON.stringify({ devices: [{ id: "x" }], revoked: [] }))).toThrow();
		expect(() => decodeRoster(JSON.stringify([]))).toThrow();
	});
});

describe("remote-roster future-stamp guard (revocation integrity)", () => {
	const now = 1_000_000; // "current" wall the ingest guard evaluates against
	const futureWall = now + HLC_MAX_DRIFT_MS + 60_000; // implausibly far ahead
	const evilFutureAdd: RosterPayload = {
		devices: [
			{
				id: "evil",
				publicKey: "pk-evil",
				label: "evil",
				addedAt: 100,
				hlc: hlc(futureWall, "evil"),
			},
		],
		revoked: [],
	};

	it("sanitizeRemoteRoster drops future-dated devices and tombstones, keeps present ones", () => {
		const roster: RosterPayload = {
			devices: [device("ok", now), evilFutureAdd.devices[0]!],
			revoked: [{ id: "gone", hlc: hlc(futureWall, "evil") }],
		};
		const safe = sanitizeRemoteRoster(roster, now);
		expect(safe.devices.map((d) => d.id)).toEqual(["ok"]);
		expect(safe.revoked).toEqual([]);
	});

	it("a revoked device cannot re-arm itself with a future-dated roster gossip", () => {
		// evil is legitimately enrolled at t=100, then revoked at t=200.
		let local = addDevice(emptyRoster(), device("evil", 100));
		local = revokeDevice(local, "evil", hlc(200, "me"));
		expect(isActiveDevice(local, "evil")).toBe(false);
		// evil gossips a roster re-adding itself stamped years in the future.
		local = mergeRemoteRoster(local, evilFutureAdd, now);
		expect(isActiveDevice(local, "evil")).toBe(false); // guard holds: stays revoked
	});

	it("plain mergeRosters WOULD let the future re-add win (the hole mergeRemoteRoster closes)", () => {
		let local = addDevice(emptyRoster(), device("evil", 100));
		local = revokeDevice(local, "evil", hlc(200, "me"));
		const unguarded = mergeRosters(local, evilFutureAdd); // no sanitize
		expect(isActiveDevice(unguarded, "evil")).toBe(true);
	});

	it("keeps a normally-stamped remote device", () => {
		const merged = mergeRemoteRoster(
			emptyRoster(),
			{ devices: [device("phone", now)], revoked: [] },
			now,
		);
		expect(isActiveDevice(merged, "phone")).toBe(true);
	});
});
