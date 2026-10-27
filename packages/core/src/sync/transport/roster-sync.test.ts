import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityWasm, peerPipe, rosterOf } from "../../test/transport-fakes";
import { decodeRoster, encodeRoster, type RosterEntry, type RosterPayload } from "..";
import type { Channel } from "./channel";
import type { PeerSession } from "./mesh";
import { currentRoster } from "./peer-auth";
import type { MeshSession } from "./peer-session";
import {
	type RosterSyncWasm,
	reapRevoked,
	reapStale,
	startRosterSync,
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

describe("verifyRosterEnvelope (the local roster it judges admissions against)", () => {
	// The optional third argument is the trust anchor for the admission gate: `admitter` is looked
	// up in it, so handing in a stale roster would let a since-revoked member keep admitting. The
	// receive loop passes the roster it already gated on; every other caller must omit it and take
	// the fresh read. See docs/p2p-sync-revocation-hardening.md.
	const wasm = {
		roster_verify: async (_p: string, _m: string, sig: string) => sig === "valid",
	} as unknown as RosterSyncWasm;
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
	const joiner: RosterEntry = {
		id: "phone",
		publicKey: "pk-phone",
		label: "phone",
		addedAt: 0,
		hlc: { wall: 2, counter: 0, node: "phone" },
		sigKey: "sk-phone",
		sig: "valid",
		admission: { by: "laptop", sig: "valid" },
	};
	const gossiped = encodeRoster({ devices: [admitter, joiner], revoked: [] });
	const idsOf = (out: string | null) => decodeRoster(out as string).devices.map((d) => d.id);

	it("uses the roster it is handed, without reading storage again", async () => {
		const withAdmitter: RosterPayload = { devices: [admitter], revoked: [] };
		const fetchLocalRoster = vi.fn(async () => encodeRoster({ devices: [], revoked: [] }));

		const out = await verifyRosterEnvelope(
			{ roster: withAdmitter, fetchLocalRoster, wasm },
			gossiped,
			withAdmitter,
		);

		expect(idsOf(out)).toContain("phone");
		expect(fetchLocalRoster).not.toHaveBeenCalled();
	});

	it("reads the roster fresh when none is handed in", async () => {
		// Same inputs, minus the third argument: the admitter is absent from storage, so the
		// admission has no live member behind it and the joiner is dropped.
		const snapshot: RosterPayload = { devices: [admitter], revoked: [] };
		const fetchLocalRoster = vi.fn(async () => encodeRoster({ devices: [], revoked: [] }));

		const out = await verifyRosterEnvelope({ roster: snapshot, fetchLocalRoster, wasm }, gossiped);

		expect(idsOf(out)).not.toContain("phone");
		expect(fetchLocalRoster).toHaveBeenCalled();
	});

	it("rejects an admission by a member the handed-in roster no longer lists", async () => {
		const revokedAdmitter: RosterPayload = { devices: [], revoked: [] };
		const out = await verifyRosterEnvelope(
			{ roster: revokedAdmitter, fetchLocalRoster: async () => "", wasm },
			gossiped,
			revokedAdmitter,
		);
		expect(idsOf(out)).not.toContain("phone");
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

// The vault goes out whole only when it changed since a peer last got it; the other ticks carry a
// heartbeat. See docs/sync-rebroadcast.md. Real sessions over in-memory pipes, on fake timers.
describe("what each tick sends", () => {
	const TICK = 4000;
	const sessions: MeshSession[] = [];

	/** One device: its vault is `vault.payload`, and every payload a peer sends it lands in `got`. */
	async function device(
		pub: string,
		peers: PeerSession[],
		vault: { payload: string },
		merge: (json: string) => Promise<void> = async () => {},
	) {
		const got: string[] = [];
		const session = await startRosterSync({
			relayUrl: "wss://relay.invalid",
			groupKeyB64: "unused",
			devicePrivB64: `priv-${pub}`,
			devicePubB64: pub,
			roster: rosterOf(["aaaa", "bbbb", "cccc"]),
			wasm: identityWasm(),
			report: () => {},
			fetchLocalPayload: async () => vault.payload,
			pushRemotePayload: async (json) => {
				await merge(json);
				got.push(json);
			},
			peerSource: async ({ onPeer }) => {
				for (const peer of peers) onPeer(peer);
				return { stop() {} };
			},
		});
		sessions.push(session);
		return got;
	}

	/** Two ends of a pipe, renamed for the device each end is talking to. */
	const pipe = (from: string, to: string) => {
		const { a, b } = peerPipe();
		return { [from]: { ...a, remotePubkey: to }, [to]: { ...b, remotePubkey: from } } as Record<
			string,
			PeerSession
		>;
	};

	beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "Date"] }));
	afterEach(() => {
		for (const s of sessions.splice(0)) s.stop();
		vi.useRealTimers();
	});

	it("sends an unchanged vault once, and keeps the peer with heartbeats", async () => {
		const ab = pipe("aaaa", "bbbb");
		const vaultA = { payload: "vault-1" };
		await device("aaaa", [ab.aaaa!], vaultA);
		const gotB = await device("bbbb", [ab.bbbb!], { payload: "b" });
		await vi.advanceTimersByTimeAsync(0);
		expect(gotB).toEqual(["vault-1"]);

		// Long past the 20 s a silent peer is dropped after: heartbeats kept it.
		await vi.advanceTimersByTimeAsync(10 * TICK);
		expect(gotB).toEqual(["vault-1"]);
		vaultA.payload = "vault-2";
		await vi.advanceTimersByTimeAsync(TICK);
		expect(gotB).toEqual(["vault-1", "vault-2"]);
	});

	it("passes a merged change on to the next device", async () => {
		const ab = pipe("aaaa", "bbbb");
		const bc = pipe("bbbb", "cccc");
		const vaultA = { payload: "a-1" };
		const vaultB = { payload: "b-1" };
		await device("aaaa", [ab.aaaa!], vaultA);
		// B's merge rewrites its own vault, which is what makes its next tick a change for C.
		await device("bbbb", [ab.bbbb!, bc.bbbb!], vaultB, async (json) => {
			vaultB.payload = `b+${json}`;
		});
		const gotC = await device("cccc", [bc.cccc!], { payload: "c" });
		await vi.advanceTimersByTimeAsync(0);
		vaultA.payload = "a-2";
		await vi.advanceTimersByTimeAsync(2 * TICK);
		expect(gotC.at(-1)).toBe("b+a-2");
	});

	it("passes a change on between two sessions over one vault, as across the desktop link", async () => {
		// The desktop app and the extension each run one session per transport (relay and local
		// link) over the same vault. A change merged through one is the other's to send on: here A
		// reaches only B's first session, and C only B's second.
		const ab = pipe("aaaa", "bbbb");
		const bc = pipe("bbbb", "cccc");
		const vaultA = { payload: "a-1" };
		const vaultB = { payload: "b-1" };
		const merge = async (json: string) => {
			vaultB.payload = `b+${json}`;
		};
		await device("aaaa", [ab.aaaa!], vaultA);
		await device("bbbb", [ab.bbbb!], vaultB, merge);
		await device("bbbb", [bc.bbbb!], vaultB, merge);
		const gotC = await device("cccc", [bc.cccc!], { payload: "c" });
		await vi.advanceTimersByTimeAsync(0);
		vaultA.payload = "a-2";
		await vi.advanceTimersByTimeAsync(2 * TICK);
		expect(gotC.at(-1)).toBe("b+a-2");
	});

	it("sends everything again when a merge fails", async () => {
		const ab = pipe("aaaa", "bbbb");
		await device("aaaa", [ab.aaaa!], { payload: "vault-1" });
		let failures = 1;
		const attempts: string[] = [];
		await device("bbbb", [ab.bbbb!], { payload: "b" }, async (json) => {
			attempts.push(json);
			if (failures-- > 0) throw new Error("background asleep");
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toEqual(["vault-1"]);
		await vi.advanceTimersByTimeAsync(TICK);
		expect(attempts).toEqual(["vault-1", "vault-1"]);
		await vi.advanceTimersByTimeAsync(3 * TICK);
		expect(attempts).toHaveLength(2);
	});

	it("sends an unchanged vault again after 10 minutes, for a loss nobody noticed", async () => {
		const ab = pipe("aaaa", "bbbb");
		await device("aaaa", [ab.aaaa!], { payload: "vault-1" });
		const gotB = await device("bbbb", [ab.bbbb!], { payload: "b" });
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(10 * 60_000 - 2 * TICK);
		expect(gotB).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(3 * TICK);
		expect(gotB).toEqual(["vault-1", "vault-1"]);
	});
});
