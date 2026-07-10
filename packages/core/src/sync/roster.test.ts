import { describe, expect, it } from "vitest";
import { HLC_MAX_DRIFT_MS, type Hlc } from "./hlc";
import {
	activeDevices,
	addDevice,
	canonicalRosterEntry,
	decodeRoster,
	emptyRoster,
	encodeRoster,
	findDevice,
	isActiveDevice,
	mergeRemoteRoster,
	mergeRosters,
	type RosterEntry,
	RosterEntrySchema,
	type RosterPayload,
	revokeDevice,
	sanitizeRemoteRoster,
	signRosterEntry,
	verifyRemoteRoster,
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

describe("roster entry signing foundation (Item A)", () => {
	it("parses a legacy entry with no sigKey/sig (backward compatible)", () => {
		const legacy = { id: "laptop", publicKey: "pk", label: "L", addedAt: 1, hlc: hlc(1, "laptop") };
		const parsed = RosterEntrySchema.parse(legacy);
		expect(parsed.sigKey).toBeUndefined();
		expect(parsed.sig).toBeUndefined();
		// A legacy roster round-trips through encode/decode unchanged.
		const r = addDevice(emptyRoster(), legacy);
		expect(decodeRoster(encodeRoster(r))).toEqual(r);
	});

	it("parses and round-trips a signed entry", () => {
		const signed = { ...device("phone", 5), sigKey: "sk-phone", sig: "sig-phone" };
		const parsed = RosterEntrySchema.parse(signed);
		expect(parsed.sigKey).toBe("sk-phone");
		const r = addDevice(emptyRoster(), signed);
		expect(findDevice(r, "phone")?.sig).toBe("sig-phone");
	});

	it("canonical form is deterministic and pins a cross-language vector", () => {
		const entry: RosterEntry = {
			id: "laptop",
			publicKey: "pk-laptop",
			label: "My laptop",
			addedAt: 1700000000000,
			hlc: { wall: 1700000000000, counter: 3, node: "laptop" },
			sigKey: "sk-laptop",
		};
		// Fixed-order array of [id, publicKey, sigKey, addedAt, wall, counter, node]. core-rust must
		// reproduce these exact bytes; if this vector changes, the Rust signer must change with it.
		expect(canonicalRosterEntry(entry)).toBe(
			'["laptop","pk-laptop","sk-laptop",1700000000000,1700000000000,3,"laptop"]',
		);
		expect(canonicalRosterEntry({ ...entry })).toBe(canonicalRosterEntry(entry));
	});

	it("signRosterEntry attaches sigKey + sig over the canonical form (which includes sigKey)", async () => {
		const base = device("phone", 5);
		let signedCanonical = "";
		const sign = async (c: string) => {
			signedCanonical = c;
			return "the-sig";
		};
		const out = await signRosterEntry(base, "sk-phone", sign);
		expect(out.sigKey).toBe("sk-phone");
		expect(out.sig).toBe("the-sig");
		expect(signedCanonical).toBe(canonicalRosterEntry({ ...base, sigKey: "sk-phone" }));
	});

	it("canonical form ignores the mutable label but binds identity + stamp", () => {
		const base: RosterEntry = {
			id: "phone",
			publicKey: "pk-phone",
			label: "Phone",
			addedAt: 10,
			hlc: hlc(10, "phone"),
			sigKey: "sk-phone",
		};
		// Renaming the device does not change what was signed.
		expect(canonicalRosterEntry({ ...base, label: "Renamed" })).toBe(canonicalRosterEntry(base));
		// Any identity/stamp field does.
		expect(canonicalRosterEntry({ ...base, publicKey: "pk-evil" })).not.toBe(
			canonicalRosterEntry(base),
		);
		expect(canonicalRosterEntry({ ...base, sigKey: "sk-evil" })).not.toBe(
			canonicalRosterEntry(base),
		);
		expect(canonicalRosterEntry({ ...base, hlc: hlc(11, "phone") })).not.toBe(
			canonicalRosterEntry(base),
		);
	});
});

describe("verifyRemoteRoster (TOFU id->key binding, Item A)", () => {
	const signed = (id: string, wall: number, sigKey: string, sig = "valid"): RosterEntry => ({
		...device(id, wall),
		sigKey,
		sig,
	});
	// Mock the host's Ed25519 verdict: an entry stamped `sig: "valid"` verifies, anything else fails.
	const isValid = (e: RosterEntry) => e.sig === "valid";
	const idsOf = (r: RosterPayload) => r.devices.map((d) => d.id).sort();

	it("accepts unsigned or validly-signed entries for ids not yet established", () => {
		const remote: RosterPayload = {
			devices: [device("plain", 1), signed("signer", 2, "sk-signer")],
			revoked: [],
		};
		expect(idsOf(verifyRemoteRoster(emptyRoster(), remote, isValid))).toEqual(["plain", "signer"]);
	});

	it("drops a signed entry whose signature does not verify", () => {
		const remote: RosterPayload = { devices: [signed("bad", 1, "sk-bad", "forged")], revoked: [] };
		expect(verifyRemoteRoster(emptyRoster(), remote, isValid).devices).toEqual([]);
	});

	it("TOFU: rejects a swapped sigKey for a known signing device (impersonation)", () => {
		const local = addDevice(emptyRoster(), signed("laptop", 1, "sk-laptop"));
		// Attacker re-presents laptop's id with its own key + a signature valid under that key.
		const remote: RosterPayload = { devices: [signed("laptop", 5, "sk-attacker")], revoked: [] };
		expect(verifyRemoteRoster(local, remote, isValid).devices).toEqual([]);
	});

	it("no downgrade: rejects an unsigned entry for a known signing device", () => {
		const local = addDevice(emptyRoster(), signed("laptop", 1, "sk-laptop"));
		const remote: RosterPayload = { devices: [device("laptop", 5)], revoked: [] };
		expect(verifyRemoteRoster(local, remote, isValid).devices).toEqual([]);
	});

	it("accepts a same-key, validly-signed update to a known signing device", () => {
		const local = addDevice(emptyRoster(), signed("laptop", 1, "sk-laptop"));
		const remote: RosterPayload = { devices: [signed("laptop", 5, "sk-laptop")], revoked: [] };
		expect(idsOf(verifyRemoteRoster(local, remote, isValid))).toEqual(["laptop"]);
	});

	it("passes tombstones through untouched (revocation stays member-level)", () => {
		const remote: RosterPayload = { devices: [], revoked: [{ id: "gone", hlc: hlc(9, "x") }] };
		expect(verifyRemoteRoster(emptyRoster(), remote, isValid).revoked).toEqual(remote.revoked);
	});
});

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
