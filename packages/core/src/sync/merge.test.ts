import { describe, expect, it } from "vitest";
import type { Hlc } from "./hlc";
import {
	deleteRecord,
	emptyReplica,
	liveRecords,
	mergeReplicas,
	putRecord,
	type ReplicaState,
	replicaFrom,
	type Stamped,
} from "./merge";

interface Rec extends Stamped {
	readonly value: string;
}

const hlc = (wall: number, node: string, counter = 0): Hlc => ({ wall, counter, node });
const rec = (id: string, value: string, stamp: Hlc): Rec => ({ id, value, hlc: stamp });

/** Live records as a sorted {id: value} map, for order-independent comparison. */
function snapshot(state: ReplicaState<Rec>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const r of liveRecords(state)) out[r.id] = r.value;
	return out;
}

describe("last-writer-wins", () => {
	it("the greater stamp wins for the same id", () => {
		const a = replicaFrom([rec("github", "old", hlc(1000, "laptop"))]);
		const b = replicaFrom([rec("github", "new", hlc(1700, "phone"))]);
		expect(snapshot(mergeReplicas(a, b))).toEqual({ github: "new" });
	});

	it("matches the worked example: phone's later whole-entry write wins", () => {
		// laptop edits password at 1500, phone edits username at 1700.
		const laptop = replicaFrom([rec("github", "pw-from-laptop", hlc(1500, "laptop"))]);
		const phone = replicaFrom([rec("github", "user-from-phone", hlc(1700, "phone"))]);
		expect(snapshot(mergeReplicas(laptop, phone))).toEqual({ github: "user-from-phone" });
	});

	it("breaks an equal wall+counter tie deterministically by node", () => {
		const a = replicaFrom([rec("x", "from-a", hlc(5, "aaa"))]);
		const b = replicaFrom([rec("x", "from-b", hlc(5, "bbb"))]);
		expect(snapshot(mergeReplicas(a, b))).toEqual({ x: "from-b" });
	});
});

describe("tombstones", () => {
	it("a delete beats an older record (no resurrection)", () => {
		const withEntry = replicaFrom([rec("github", "v", hlc(1700, "phone"))]);
		const deleted = deleteRecord(withEntry, "github", hlc(2000, "phone"));
		// A stale peer still holding the entry must not bring it back.
		const stale = replicaFrom([rec("github", "v", hlc(1700, "phone"))]);
		expect(snapshot(mergeReplicas(deleted, stale))).toEqual({});
		expect(snapshot(mergeReplicas(stale, deleted))).toEqual({});
	});

	it("an edit stamped after a delete resurrects the entry", () => {
		const deleted = deleteRecord(emptyReplica<Rec>(), "github", hlc(2000, "phone"));
		const edited = replicaFrom([rec("github", "undeleted", hlc(2100, "laptop"))]);
		expect(snapshot(mergeReplicas(deleted, edited))).toEqual({ github: "undeleted" });
	});

	it("deletion wins an exact stamp tie", () => {
		const stamp = hlc(2000, "phone");
		const deleted = deleteRecord(emptyReplica<Rec>(), "github", stamp);
		const present = replicaFrom([rec("github", "v", stamp)]);
		expect(snapshot(mergeReplicas(deleted, present))).toEqual({});
	});

	it("keeps the max tombstone stamp per id", () => {
		const a = deleteRecord(emptyReplica<Rec>(), "x", hlc(10, "a"));
		const b = deleteRecord(emptyReplica<Rec>(), "x", hlc(20, "b"));
		const merged = mergeReplicas(a, b);
		// A record between the two deletes stays dead; one after the later delete lives.
		expect(snapshot(mergeReplicas(merged, replicaFrom([rec("x", "mid", hlc(15, "c"))])))).toEqual(
			{},
		);
		expect(snapshot(mergeReplicas(merged, replicaFrom([rec("x", "after", hlc(25, "c"))])))).toEqual(
			{ x: "after" },
		);
	});
});

describe("convergence", () => {
	const a = replicaFrom([rec("1", "a1", hlc(100, "a")), rec("2", "a2", hlc(400, "a"))]);
	const b = replicaFrom([rec("1", "b1", hlc(200, "b")), rec("3", "b3", hlc(300, "b"))]);
	const c = deleteRecord(replicaFrom([rec("2", "c2", hlc(150, "c"))]), "1", hlc(500, "c"));

	it("is commutative", () => {
		expect(snapshot(mergeReplicas(a, b))).toEqual(snapshot(mergeReplicas(b, a)));
	});

	it("is idempotent", () => {
		const m = mergeReplicas(a, b);
		expect(snapshot(mergeReplicas(m, m))).toEqual(snapshot(m));
		expect(snapshot(mergeReplicas(m, a))).toEqual(snapshot(m));
	});

	it("reaches the same live set regardless of merge order", () => {
		const order1 = mergeReplicas(mergeReplicas(a, b), c);
		const order2 = mergeReplicas(a, mergeReplicas(b, c));
		const order3 = mergeReplicas(mergeReplicas(c, a), b);
		const expected = { "2": "a2", "3": "b3" }; // id 1 deleted at 500 by c, beats a/b records
		expect(snapshot(order1)).toEqual(expected);
		expect(snapshot(order2)).toEqual(expected);
		expect(snapshot(order3)).toEqual(expected);
	});
});

describe("local mutators", () => {
	it("putRecord ignores a stale stamp", () => {
		const s0 = putRecord(emptyReplica<Rec>(), rec("x", "new", hlc(20, "a")));
		const s1 = putRecord(s0, rec("x", "old", hlc(10, "a")));
		expect(snapshot(s1)).toEqual({ x: "new" });
		expect(s1).toBe(s0); // unchanged reference
	});

	it("deleteRecord ignores a stale tombstone", () => {
		const s0 = deleteRecord(emptyReplica<Rec>(), "x", hlc(20, "a"));
		const s1 = deleteRecord(s0, "x", hlc(10, "a"));
		expect(s1).toBe(s0);
	});

	it("does not mutate the input state", () => {
		const s0 = emptyReplica<Rec>();
		putRecord(s0, rec("x", "v", hlc(1, "a")));
		expect(s0.records.size).toBe(0);
	});
});
