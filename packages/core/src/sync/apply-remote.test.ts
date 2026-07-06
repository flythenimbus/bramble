import { describe, expect, it } from "vitest";
import type { EncryptedEntry } from "../vault-format";
import { applyRemotePayload, payloadsEquivalent, type VaultSyncPort } from "./apply-remote";
import { type EntriesPayload, emptyEntriesPayload } from "./entries-payload";
import type { Hlc } from "./hlc";

const hlc = (wall: number, node: string): Hlc => ({ wall, counter: 0, node });
const env = (id: string, ct: string, stamp: Hlc): EncryptedEntry => ({
	id,
	wrappedDek: "w",
	dekIv: "d",
	ciphertext: ct,
	iv: "i",
	hlc: stamp,
});
const payload = (
	entries: EncryptedEntry[],
	tombstones: { id: string; hlc: Hlc }[] = [],
): EntriesPayload => ({ entries, tombstones });

/** A fake port recording writes + witnessed stamps + call order, from a given local payload. */
function fakePort(local: EntriesPayload) {
	const writes: EntriesPayload[] = [];
	const witnessed: Hlc[][] = [];
	const order: string[] = [];
	const port: VaultSyncPort = {
		readLocal: () => {
			order.push("read");
			return Promise.resolve(local);
		},
		witnessRemote: (stamps) => {
			order.push("witness");
			witnessed.push(stamps);
			return Promise.resolve();
		},
		writeMerged: (m) => {
			order.push("write");
			writes.push(m);
			return Promise.resolve();
		},
	};
	return { port, writes, witnessed, order };
}

const live = (p: EntriesPayload) => p.entries.map((e) => e.id).sort();

describe("applyRemotePayload", () => {
	it("merges a new remote entry and writes once", async () => {
		const { port, writes } = fakePort(payload([env("a", "a", hlc(100, "x"))]));
		const remote = payload([env("b", "b", hlc(200, "y"))]);
		const res = await applyRemotePayload(port, remote);
		expect(res.changed).toBe(true);
		expect(live(res.payload)).toEqual(["a", "b"]);
		expect(writes).toHaveLength(1);
		expect(live(writes[0]!)).toEqual(["a", "b"]);
	});

	it("witnesses the remote stamps before writing, when changed", async () => {
		const { port, witnessed, order } = fakePort(payload([env("a", "a", hlc(100, "x"))]));
		const remote = payload([env("b", "b", hlc(200, "y"))], [{ id: "c", hlc: hlc(300, "z") }]);
		await applyRemotePayload(port, remote);
		// Both entry and tombstone stamps are witnessed (winners and losers alike).
		expect(witnessed).toEqual([[hlc(200, "y"), hlc(300, "z")]]);
		// The clock must advance before the merged blob is persisted.
		expect(order).toEqual(["read", "witness", "write"]);
	});

	it("does not write or witness when the remote is redundant", async () => {
		const local = payload([env("a", "a", hlc(100, "x"))]);
		const { port, writes, witnessed } = fakePort(local);
		const res = await applyRemotePayload(port, payload([env("a", "a", hlc(100, "x"))]));
		expect(res.changed).toBe(false);
		expect(writes).toHaveLength(0);
		expect(witnessed).toHaveLength(0);
	});

	it("does not write when the remote is strictly older", async () => {
		const { port, writes } = fakePort(payload([env("a", "new", hlc(500, "x"))]));
		const res = await applyRemotePayload(port, payload([env("a", "old", hlc(100, "y"))]));
		expect(res.changed).toBe(false);
		expect(writes).toHaveLength(0);
		expect(res.payload.entries[0]?.ciphertext).toBe("new");
	});

	it("applies a remote deletion", async () => {
		const { port, writes } = fakePort(payload([env("a", "a", hlc(100, "x"))]));
		const res = await applyRemotePayload(port, payload([], [{ id: "a", hlc: hlc(200, "y") }]));
		expect(res.changed).toBe(true);
		expect(live(res.payload)).toEqual([]);
		expect(writes).toHaveLength(1);
	});

	it("seeds an empty local vault from a remote", async () => {
		const { port, writes } = fakePort(emptyEntriesPayload());
		const res = await applyRemotePayload(port, payload([env("a", "a", hlc(100, "x"))]));
		expect(res.changed).toBe(true);
		expect(live(res.payload)).toEqual(["a"]);
		expect(writes).toHaveLength(1);
	});

	// A peer's payload is untrusted: a stamp far in the future is poisoned (an honest clock
	// clamps its own), so it is dropped before merge/witness.
	const FAR_FUTURE = 9_000_000_000_000; // year ~2255

	it("drops a future-dated remote entry (poisoned stamp), merging nothing", async () => {
		const { port, writes, witnessed } = fakePort(payload([env("a", "a", hlc(100, "x"))]));
		const res = await applyRemotePayload(
			port,
			payload([env("evil", "evil", hlc(FAR_FUTURE, "evil"))]),
		);
		expect(res.changed).toBe(false);
		expect(live(res.payload)).toEqual(["a"]);
		expect(writes).toHaveLength(0);
		expect(witnessed).toHaveLength(0);
	});

	it("drops a future-dated remote tombstone (cannot force-delete via a poisoned stamp)", async () => {
		const { port, writes } = fakePort(payload([env("a", "a", hlc(100, "x"))]));
		const res = await applyRemotePayload(
			port,
			payload([], [{ id: "a", hlc: hlc(FAR_FUTURE, "evil") }]),
		);
		expect(res.changed).toBe(false);
		expect(live(res.payload)).toEqual(["a"]); // "a" survives; the poisoned tombstone is ignored
		expect(writes).toHaveLength(0);
	});
});

describe("payloadsEquivalent", () => {
	it("ignores entry order and ciphertext at equal stamps", () => {
		const a = payload([env("1", "x", hlc(1, "n")), env("2", "y", hlc(2, "n"))]);
		const b = payload([env("2", "y", hlc(2, "n")), env("1", "DIFFERENT", hlc(1, "n"))]);
		expect(payloadsEquivalent(a, b)).toBe(true);
	});

	it("detects a differing stamp", () => {
		const a = payload([env("1", "x", hlc(1, "n"))]);
		const b = payload([env("1", "x", hlc(2, "n"))]);
		expect(payloadsEquivalent(a, b)).toBe(false);
	});

	it("detects differing tombstones", () => {
		const a = payload([], [{ id: "1", hlc: hlc(1, "n") }]);
		const b = payload([]);
		expect(payloadsEquivalent(a, b)).toBe(false);
	});
});
