import { describe, expect, it } from "vitest";
import type { EncryptedEntry } from "../vault-format";
import type { EntriesPayload } from "./entries-payload";
import type { Hlc } from "./hlc";
import { mergeEntriesPayload } from "./vault-merge";

const hlc = (wall: number, node: string, counter = 0): Hlc => ({ wall, counter, node });

/** A sealed envelope whose ciphertext is tagged so we can tell which side won. */
const env = (id: string, ct: string, stamp: Hlc): EncryptedEntry => ({
	id,
	wrappedDek: `wd-${ct}`,
	dekIv: `di-${ct}`,
	ciphertext: ct,
	iv: `iv-${ct}`,
	hlc: stamp,
});

const payload = (
	entries: EncryptedEntry[],
	tombstones: { id: string; hlc: Hlc }[] = [],
): EntriesPayload => ({ entries, tombstones });

/** Live entries as id -> ciphertext, order-independent. */
function live(p: EntriesPayload): Record<string, string> {
	const out: Record<string, string> = {};
	for (const e of p.entries) out[e.id] = e.ciphertext;
	return out;
}

describe("mergeEntriesPayload", () => {
	it("carries the winning side's sealed envelope verbatim", () => {
		const a = payload([env("github", "ct-laptop", hlc(1500, "laptop"))]);
		const b = payload([env("github", "ct-phone", hlc(1700, "phone"))]);
		const merged = mergeEntriesPayload(a, b);
		const winner = merged.entries.find((e) => e.id === "github");
		expect(winner).toEqual(env("github", "ct-phone", hlc(1700, "phone")));
	});

	it("unions distinct entries from both sides", () => {
		const a = payload([env("1", "a1", hlc(100, "a"))]);
		const b = payload([env("2", "b2", hlc(200, "b"))]);
		expect(live(mergeEntriesPayload(a, b))).toEqual({ "1": "a1", "2": "b2" });
	});

	it("a tombstone removes an entry a stale peer still holds", () => {
		const deleted = payload([], [{ id: "x", hlc: hlc(300, "a") }]);
		const stale = payload([env("x", "old", hlc(100, "a"))]);
		expect(live(mergeEntriesPayload(deleted, stale))).toEqual({});
		expect(live(mergeEntriesPayload(stale, deleted))).toEqual({});
	});

	it("an edit stamped after a delete resurrects the entry", () => {
		const deleted = payload([], [{ id: "x", hlc: hlc(300, "a") }]);
		const edited = payload([env("x", "fresh", hlc(400, "b"))]);
		expect(live(mergeEntriesPayload(deleted, edited))).toEqual({ x: "fresh" });
	});

	it("keeps the merged tombstone graveyard", () => {
		const a = payload([env("keep", "k", hlc(10, "a"))], [{ id: "gone", hlc: hlc(20, "a") }]);
		const b = payload([env("keep", "k", hlc(10, "a"))]);
		const merged = mergeEntriesPayload(a, b);
		expect(merged.tombstones).toEqual([{ id: "gone", hlc: hlc(20, "a") }]);
	});

	it("is commutative and idempotent over the live set", () => {
		const a = payload(
			[env("1", "a1", hlc(100, "a")), env("2", "a2", hlc(400, "a"))],
			[{ id: "3", hlc: hlc(50, "a") }],
		);
		const b = payload(
			[env("1", "b1", hlc(200, "b")), env("3", "b3", hlc(300, "b"))],
			[{ id: "2", hlc: hlc(500, "b") }],
		);
		const ab = mergeEntriesPayload(a, b);
		const ba = mergeEntriesPayload(b, a);
		expect(live(ab)).toEqual(live(ba));
		// id 1 -> b (200>100); id 2 deleted at 500 > 400; id 3 -> b3 (300>50).
		expect(live(ab)).toEqual({ "1": "b1", "3": "b3" });
		expect(live(mergeEntriesPayload(ab, ab))).toEqual(live(ab));
	});
});
