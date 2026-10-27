import { describe, expect, it } from "vitest";
import { fileRecord } from "../test/vault-fixtures";
import type { EncryptedEntry } from "../vault-format";
import { applyRemotePayload, payloadsEquivalent, type VaultSyncPort } from "./apply-remote";
import {
	type EntriesPayload,
	emptyEntriesPayload,
	type FileRecord,
	type Tombstone,
} from "./entries-payload";
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
const payload = (entries: EncryptedEntry[], tombstones: Tombstone[] = []): EntriesPayload => ({
	entries,
	tombstones,
});

/** A fake port recording writes + witnessed stamps + call order, from a given local payload. */
function fakePort(local: EntriesPayload, { unopenable = [] }: { unopenable?: string[] } = {}) {
	const writes: EntriesPayload[] = [];
	const witnessed: Hlc[][] = [];
	const order: string[] = [];
	const checked: string[][] = [];
	const port: VaultSyncPort = {
		openable: (es) => {
			checked.push(es.map((e) => e.id));
			return Promise.resolve(es.map((e) => !unopenable.includes(e.id)));
		},
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
	return { port, writes, witnessed, order, checked };
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

	it("a stripped copy is not equivalent to its source", () => {
		const withVv = payload([{ ...env("1", "x", hlc(1, "n")), vv: { n: hlc(1, "n") } }]);
		const stripped = payload([env("1", "x", hlc(1, "n"))]);
		expect(payloadsEquivalent(withVv, stripped)).toBe(false);
	});

	it("a tombstone whose vv grew under the same stamp is not equivalent", () => {
		const a = payload([], [{ id: "1", hlc: hlc(5, "n"), vv: { n: hlc(5, "n") } }]);
		const b = payload([], [{ id: "1", hlc: hlc(5, "n"), vv: { n: hlc(5, "n"), m: hlc(3, "m") } }]);
		expect(payloadsEquivalent(a, b)).toBe(false);
	});

	it("conflicts are part of equivalence", () => {
		const shown = { ...env("1", "x", hlc(2, "n")), vv: { n: hlc(2, "n") } };
		const sibling = { ...env("1", "y", hlc(1, "m")), vv: { m: hlc(1, "m") } };
		const a = payload([shown]);
		const b: EntriesPayload = { ...payload([shown]), conflicts: [sibling] };
		expect(payloadsEquivalent(a, b)).toBe(false);
		expect(payloadsEquivalent(b, { ...b, conflicts: [{ ...sibling, ciphertext: "z" }] })).toBe(
			true,
		);
	});
});

const fileRec = (id: string, stamp: Hlc, hash = "a".repeat(64)): FileRecord =>
	fileRecord({ id, hlc: stamp, hash, size: 1024 });

describe("the file manifest propagates", () => {
	// The settings trap, applied to files. A peer that attaches a file touches no entry, so if
	// the manifest were left out of the equivalence check the merge would be judged redundant,
	// no write would happen, no re-broadcast would follow, and the attachment would appear to
	// sync only if the user later happened to edit an entry.
	it("a file-only remote change is not judged equivalent", () => {
		const base = payload([env("1", "a", hlc(100, "a"))]);
		const withFile: EntriesPayload = { ...base, files: [fileRec("f1", hlc(200, "b"))] };
		expect(payloadsEquivalent(base, withFile)).toBe(false);
		expect(payloadsEquivalent(withFile, base)).toBe(false);
	});

	it("a file-only remote change writes and re-broadcasts", async () => {
		const local = payload([env("1", "a", hlc(100, "a"))]);
		const { port, writes } = fakePort(local);
		const remote: EntriesPayload = { ...local, files: [fileRec("f1", hlc(200, "b"))] };
		const result = await applyRemotePayload(port, remote);
		expect(result.changed).toBe(true);
		expect(writes).toHaveLength(1);
		expect(writes[0]?.files?.map((f) => f.id)).toEqual(["f1"]);
	});

	it("a file-only deletion is not judged equivalent", () => {
		const a: EntriesPayload = {
			entries: [],
			tombstones: [],
			files: [fileRec("f1", hlc(100, "a"))],
		};
		const b: EntriesPayload = {
			...a,
			fileTombstones: [{ id: "f1", hlc: hlc(200, "b") }],
		};
		expect(payloadsEquivalent(a, b)).toBe(false);
	});

	it("a delete's mark on a file is not judged equivalent to no mark", () => {
		const a: EntriesPayload = {
			entries: [],
			tombstones: [],
			files: [fileRec("f1", hlc(100, "a"))],
		};
		const b: EntriesPayload = { ...a, fileCascades: [{ id: "f1", hlc: hlc(200, "b") }] };
		expect(payloadsEquivalent(a, b)).toBe(false);
	});

	it("witnesses file stamps, so a later local write sorts after them", async () => {
		const { port, witnessed } = fakePort(emptyEntriesPayload());
		await applyRemotePayload(port, {
			entries: [],
			tombstones: [],
			files: [fileRec("f1", hlc(900, "b"))],
			fileTombstones: [{ id: "f2", hlc: hlc(950, "b") }],
			fileCascades: [{ id: "f1", hlc: hlc(960, "b") }],
		});
		expect(witnessed[0]).toEqual(
			expect.arrayContaining([hlc(900, "b"), hlc(950, "b"), hlc(960, "b")]),
		);
	});

	it("drops a future-dated file record and tombstone (poisoned stamps)", async () => {
		const far = { wall: Date.now() + 5 * 24 * 3600_000, counter: 0, node: "evil" };
		const { port, writes } = fakePort(emptyEntriesPayload());
		const result = await applyRemotePayload(port, {
			entries: [],
			tombstones: [],
			files: [fileRec("f1", far)],
			fileTombstones: [{ id: "f2", hlc: far }],
		});
		expect(result.changed).toBe(false);
		expect(writes).toHaveLength(0);
	});

	it("an unchanged manifest is still redundant", async () => {
		const local: EntriesPayload = {
			entries: [],
			tombstones: [],
			files: [fileRec("f1", hlc(100, "a"))],
		};
		const { port, writes } = fakePort(local);
		const result = await applyRemotePayload(port, local);
		expect(result.changed).toBe(false);
		expect(writes).toHaveLength(0);
	});
});

describe("applyRemotePayload admission", () => {
	const shown = { ...env("a", "shown", hlc(100, "x")), vv: { x: hlc(100, "x") } };
	const sibling = {
		...env("a", "sibling", hlc(50, "y")),
		vv: { y: hlc(50, "y"), z: hlc(40, "z") },
	};

	it("a remote conflict that doesn't decrypt here is refused", async () => {
		const rejected = new Set<string>();
		const { port, writes } = fakePort(payload([shown]), { unopenable: ["a"] });
		const remote: EntriesPayload = { ...payload([shown]), conflicts: [sibling] };
		const res = await applyRemotePayload(port, remote, { rejected });
		expect(res.changed).toBe(false);
		expect(writes).toHaveLength(0);
		expect(rejected.has("a|50|0|y")).toBe(true);
	});

	it("conflict stamps and vv values are witnessed", async () => {
		const { port, witnessed } = fakePort(payload([shown]));
		await applyRemotePayload(port, { ...payload([shown]), conflicts: [sibling] });
		expect(witnessed.flat().map((h) => h.wall)).toEqual(expect.arrayContaining([50, 40]));
	});

	it("a remote payload carrying only a new conflict is a change and is written", async () => {
		const { port, writes } = fakePort(payload([shown]));
		const res = await applyRemotePayload(port, { ...payload([shown]), conflicts: [sibling] });
		expect(res.changed).toBe(true);
		expect(writes[0]?.conflicts?.map((e) => e.ciphertext)).toEqual(["sibling"]);
	});

	it("does not merge a remote entry that doesn't decrypt under this vault's key", async () => {
		const { port, writes } = fakePort(payload([env("a", "a", hlc(100, "x"))]), {
			unopenable: ["stray"],
		});
		const res = await applyRemotePayload(port, payload([env("stray", "s", hlc(200, "y"))]));
		expect(res.changed).toBe(false);
		expect(writes).toHaveLength(0);
	});

	it("merges the entries that decrypt and drops the rest", async () => {
		const { port, writes } = fakePort(payload([]), { unopenable: ["stray"] });
		await applyRemotePayload(
			port,
			payload([env("ok", "o", hlc(1, "y")), env("stray", "s", hlc(1, "y"))]),
		);
		expect(live(writes[0]!)).toEqual(["ok"]);
	});

	it("does not let a refused entry advance this device's clock", async () => {
		const { port, witnessed } = fakePort(payload([]), { unopenable: ["stray"] });
		await applyRemotePayload(
			port,
			payload([env("ok", "o", hlc(1, "y")), env("stray", "s", hlc(9_000, "z"))]),
		);
		expect(witnessed.flat().map((h) => h.wall)).toEqual([1]);
	});

	it("only checks entries that would win the merge", async () => {
		const { port, checked } = fakePort(payload([env("a", "a", hlc(300, "x"))]));
		await applyRemotePayload(port, payload([env("a", "old", hlc(100, "y"))]));
		expect(checked).toEqual([]);
	});

	it("does not re-check a version it already refused", async () => {
		const rejected = new Set<string>();
		const { port, checked } = fakePort(payload([]), { unopenable: ["stray"] });
		const remote = payload([env("stray", "s", hlc(1, "y"))]);
		await applyRemotePayload(port, remote, { rejected });
		await applyRemotePayload(port, remote, { rejected });
		expect(checked).toEqual([["stray"]]);
	});

	it("checks a newer version of an id it refused before", async () => {
		const rejected = new Set<string>();
		const { port, checked } = fakePort(payload([]), { unopenable: ["stray"] });
		await applyRemotePayload(port, payload([env("stray", "s", hlc(1, "y"))]), { rejected });
		await applyRemotePayload(port, payload([env("stray", "s2", hlc(2, "y"))]), { rejected });
		expect(checked).toEqual([["stray"], ["stray"]]);
	});
});

describe("applyRemotePayload combining", () => {
	const local = payload([env("a", "a", hlc(100, "x"))]);
	const remote = payload([env("b", "b", hlc(200, "y"))]);

	it("witnesses the combined stamps and writes the combined payload", async () => {
		const mine = { ...env("a", "a1", hlc(100, "x")), vv: { x: hlc(100, "x") } };
		const theirs = { ...env("a", "a2", hlc(90, "y")), vv: { y: hlc(90, "y") } };
		const { port, writes, witnessed } = fakePort(payload([mine]));
		const merged = hlc(300, "~merge:m");
		port.combineSiblings = async (p) => ({
			payload: { ...p, entries: [...p.entries, env("c", "c", merged)] },
			stamps: [merged],
		});
		await applyRemotePayload(port, payload([theirs]), { combine: true });
		expect(witnessed[0]).toContainEqual(merged);
		expect(live(writes[0]!)).toEqual(["a", "c"]);
	});

	it("a combine that fails still writes the merge", async () => {
		const mine = { ...env("a", "a1", hlc(100, "x")), vv: { x: hlc(100, "x") } };
		const theirs = { ...env("a", "a2", hlc(90, "y")), vv: { y: hlc(90, "y") } };
		const { port, writes } = fakePort(payload([mine]));
		port.combineSiblings = () => Promise.reject(new Error("offscreen gone"));
		const res = await applyRemotePayload(port, payload([theirs]), { combine: true });
		expect(res.changed).toBe(true);
		expect(writes[0]!.conflicts).toEqual([theirs]);
	});

	it("only ids whose versions the merge changed are combined", async () => {
		const a1 = { ...env("a", "a1", hlc(100, "x")), vv: { x: hlc(100, "x") } };
		const a2 = { ...env("a", "a2", hlc(90, "y")), vv: { y: hlc(90, "y") } };
		const b1 = { ...env("b", "b1", hlc(100, "x")), vv: { x: hlc(100, "x") } };
		const b2 = { ...env("b", "b2", hlc(90, "y")), vv: { y: hlc(90, "y") } };
		const { port } = fakePort({ entries: [a1, b1], tombstones: [], conflicts: [a2] });
		const asked: string[][] = [];
		port.combineSiblings = async (p, ids) => {
			asked.push([...ids].sort());
			return { payload: p, stamps: [] };
		};
		await applyRemotePayload(
			port,
			{ entries: [a1, b2], tombstones: [], conflicts: [a2] },
			{
				combine: true,
			},
		);
		expect(asked).toEqual([["b"]]);
	});

	it("a rebroadcast of siblings already held doesn't reopen them", async () => {
		const a1 = { ...env("a", "a1", hlc(100, "x")), vv: { x: hlc(100, "x") } };
		const a2 = { ...env("a", "a2", hlc(90, "y")), vv: { y: hlc(90, "y") } };
		const held = { entries: [a1], tombstones: [], conflicts: [a2] };
		const { port } = fakePort(held);
		let called = false;
		port.combineSiblings = async (p) => {
			called = true;
			return { payload: p, stamps: [] };
		};
		await applyRemotePayload(port, held, { combine: true });
		expect(called).toBe(false);
	});

	it("combining off never calls the port", async () => {
		const { port } = fakePort(local);
		let called = false;
		port.combineSiblings = async (p) => {
			called = true;
			return { payload: p, stamps: [] };
		};
		await applyRemotePayload(port, remote, { combine: false });
		await applyRemotePayload(port, remote);
		expect(called).toBe(false);
	});
});
