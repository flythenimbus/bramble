import { describe, expect, it } from "vitest";
import type { Hlc } from "./hlc";
import {
	activeDevices,
	addDevice,
	decodeRoster,
	emptyRoster,
	encodeRoster,
	findDevice,
	isActiveDevice,
	mergeRosters,
	type RosterEntry,
	type RosterPayload,
	revokeDevice,
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
