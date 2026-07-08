import { describe, expect, it, vi } from "vitest";
import { decodeRoster, encodeRoster, type RosterEntry, type RosterPayload } from "..";
import type { Channel } from "./channel";
import {
	currentRoster,
	type RosterSyncWasm,
	reapRevoked,
	reapStale,
	verifyRosterEnvelope,
} from "./roster-sync";

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

describe("verifyRosterEnvelope (Item A: reject impersonation before merge)", () => {
	const entry = (id: string, sigKey?: string, sig?: string): RosterEntry => ({
		id,
		publicKey: `pk-${id}`,
		label: id,
		addedAt: 0,
		hlc: { wall: 1, counter: 0, node: id },
		...(sigKey ? { sigKey } : {}),
		...(sig ? { sig } : {}),
	});
	// Mock the host Ed25519 verdict: a sig of "valid" verifies, anything else fails.
	const wasm = {
		roster_verify: async (_p: string, _m: string, sig: string) => sig === "valid",
	} as unknown as RosterSyncWasm;
	const opts = (local: RosterPayload) => ({
		roster: local,
		fetchLocalRoster: async () => encodeRoster(local),
		wasm,
	});

	it("drops a gossiped entry that swaps a known signing device's key (impersonation)", async () => {
		const local: RosterPayload = { devices: [entry("laptop", "sk-laptop", "valid")], revoked: [] };
		const remote: RosterPayload = {
			devices: [entry("laptop", "sk-attacker", "valid")],
			revoked: [],
		};
		const out = await verifyRosterEnvelope(opts(local), encodeRoster(remote));
		expect(out).not.toBeNull();
		expect(decodeRoster(out as string).devices).toEqual([]);
	});

	it("keeps a valid same-key signed update", async () => {
		const local: RosterPayload = { devices: [entry("laptop", "sk-laptop", "valid")], revoked: [] };
		const remote: RosterPayload = { devices: [entry("laptop", "sk-laptop", "valid")], revoked: [] };
		const out = await verifyRosterEnvelope(opts(local), encodeRoster(remote));
		expect(decodeRoster(out as string).devices.map((d) => d.id)).toEqual(["laptop"]);
	});

	it("passes the roster through unchanged when the host has no roster_verify (degrade)", async () => {
		const json = encodeRoster({ devices: [entry("x", "sk-x", "forged")], revoked: [] });
		const noVerify = {
			roster: rosterWith([]),
			fetchLocalRoster: async () => "",
			wasm: {} as unknown as RosterSyncWasm,
		};
		expect(await verifyRosterEnvelope(noVerify, json)).toBe(json);
	});

	it("returns null on an unparseable roster", async () => {
		expect(await verifyRosterEnvelope(opts(rosterWith([])), "not json")).toBeNull();
	});
});

describe("verifyRosterEnvelope (Item A: password-authority admission gate for new ids)", () => {
	// Host verdict mock: a signature string of "valid" verifies (covers both the self-sig and the
	// admission sig; the admission sig is checked against the admitter's published admissionKey).
	const wasm = {
		roster_verify: async (_p: string, _m: string, sig: string) => sig === "valid",
	} as unknown as RosterSyncWasm;

	// A live member that admits others: it has published an admissionKey (derived from the master
	// password), so peers can verify who it admits.
	const admitter: RosterEntry = {
		id: "laptop",
		publicKey: "pk-laptop",
		label: "laptop",
		addedAt: 0,
		hlc: { wall: 1, counter: 0, node: "laptop" },
		sigKey: "sk-laptop",
		sig: "valid",
		admissionKey: "adm-laptop",
	};
	const local: RosterPayload = { devices: [admitter], revoked: [] };
	const opts = { roster: local, fetchLocalRoster: async () => encodeRoster(local), wasm };

	// A brand-new, self-signed joiner id, admitted by `laptop` (the shape the inviter produces).
	const joiner = (admissionSig: string, by = "laptop"): RosterEntry => ({
		id: "phone",
		publicKey: "pk-phone",
		label: "phone",
		addedAt: 0,
		hlc: { wall: 2, counter: 0, node: "phone" },
		sigKey: "sk-phone",
		sig: "valid",
		admission: { by, sig: admissionSig },
	});
	const idsAfter = async (
		o: Parameters<typeof verifyRosterEnvelope>[0],
		remote: RosterPayload,
	): Promise<string[]> => {
		const out = await verifyRosterEnvelope(o, encodeRoster(remote));
		return decodeRoster(out as string).devices.map((d) => d.id);
	};

	it("admits a new id whose admission is signed by a live member's admission key", async () => {
		expect(await idsAfter(opts, { devices: [admitter, joiner("valid")], revoked: [] })).toContain(
			"phone",
		);
	});

	it("drops a new id whose admission signature is invalid", async () => {
		expect(
			await idsAfter(opts, { devices: [admitter, joiner("forged")], revoked: [] }),
		).not.toContain("phone");
	});

	it("drops a new id admitted by a non-member", async () => {
		expect(
			await idsAfter(opts, { devices: [admitter, joiner("valid", "ghost")], revoked: [] }),
		).not.toContain("phone");
	});

	it("drops a new id admitted by a member with no published admission key", async () => {
		const keyless: RosterEntry = {
			id: "tablet",
			publicKey: "pk-tablet",
			label: "tablet",
			addedAt: 0,
			hlc: { wall: 3, counter: 0, node: "tablet" },
			sigKey: "sk-tablet",
			sig: "valid",
		};
		const localKeyless: RosterPayload = { devices: [keyless], revoked: [] };
		const optsKeyless = {
			roster: localKeyless,
			fetchLocalRoster: async () => encodeRoster(localKeyless),
			wasm,
		};
		expect(
			await idsAfter(optsKeyless, {
				devices: [keyless, joiner("valid", "tablet")],
				revoked: [],
			}),
		).not.toContain("phone");
	});

	it("tolerates a new signed id with no admission (phase-1 verify-if-present)", async () => {
		const noAdmission: RosterEntry = {
			id: "phone",
			publicKey: "pk-phone",
			label: "phone",
			addedAt: 0,
			hlc: { wall: 2, counter: 0, node: "phone" },
			sigKey: "sk-phone",
			sig: "valid",
		};
		expect(await idsAfter(opts, { devices: [admitter, noAdmission], revoked: [] })).toContain(
			"phone",
		);
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
