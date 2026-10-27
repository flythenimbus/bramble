import { describe, expect, it } from "vitest";
import type { Entry, EntryData, LoginEntryData } from "../hooks/useVault";
import {
	compareHlc,
	containsHistory,
	decodeEntriesPayload,
	type EntriesPayload,
	type FileManifest,
	type Hlc,
	isAncestor,
	mergeEntriesPayload,
} from "../sync";
import { fileRecord } from "../test/vault-fixtures";
import type { EncryptedEntry } from "../vault-format";
import {
	conflictsOf,
	type OpenedVersion,
	type VaultEntries,
	vaultEntriesFromPayload,
} from "./entry-mutations";
import { harness } from "./entry-mutations.harness";
import { effectivePartStamps, PART_STAMP_FIELDS } from "./parts";

/** A written entry's stamps as combining reads them (own-stamp ones are left out on disk). */
const eff = (e: Entry) => effectivePartStamps(e, { hlc: e.partStampsAt! });
const empty = (): VaultEntries => ({
	entries: [],
	stamps: new Map(),
	causal: new Map(),
	tombstones: new Map(),
	tombstoneCausal: new Map(),
	conflicts: [],
});
const login = (name: string): EntryData => ({
	type: "login",
	name,
	urls: [],
	username: "u",
	password: "p",
});
const note = (name: string): EntryData => ({ type: "note", name });
// Login-typed variant, so login-only fields survive the union in an override.
const loginWith = (name: string, over: Partial<LoginEntryData> = {}): LoginEntryData => ({
	type: "login",
	name,
	urls: [],
	username: "u",
	password: "p",
	...over,
});

type Mutation = [string, (h: ReturnType<typeof harness>, s: VaultEntries) => Promise<VaultEntries>];

/** Every entry mutation. Each rebuilds the state it persists, so each is its own chance to drop
 * whatever rides beside the entries: synced settings, the file manifest. */
const ENTRY_MUTATIONS: Mutation[] = [
	["add", async (h: ReturnType<typeof harness>, s: VaultEntries) => h.mutations.add(s, login("x"))],
	[
		"importMany",
		async (h: ReturnType<typeof harness>, s: VaultEntries) =>
			h.mutations.importMany(s, [login("x")]),
	],
	[
		"update",
		async (h: ReturnType<typeof harness>, s: VaultEntries) => {
			const a = await h.mutations.add(s, login("x"));
			return h.mutations.update(a, a.entries[0]!.id, login("y"));
		},
	],
	[
		"remove",
		async (h: ReturnType<typeof harness>, s: VaultEntries) => {
			const a = await h.mutations.add(s, login("x"));
			return h.mutations.remove(a, a.entries[0]!.id);
		},
	],
	[
		"removeMany",
		async (h: ReturnType<typeof harness>, s: VaultEntries) => {
			const a = await h.mutations.add(s, login("x"));
			return h.mutations.removeMany(a, [a.entries[0]!.id]);
		},
	],
	[
		"setArchived",
		async (h: ReturnType<typeof harness>, s: VaultEntries) => {
			const a = await h.mutations.add(s, login("x"));
			return h.mutations.setArchived(a, [a.entries[0]!.id], true);
		},
	],
	[
		"setTags",
		async (h: ReturnType<typeof harness>, s: VaultEntries) => {
			const a = await h.mutations.add(s, login("x"));
			return h.mutations.setTags(a, [a.entries[0]!.id], { add: ["work"] });
		},
	],
	[
		"touch",
		async (h: ReturnType<typeof harness>, s: VaultEntries) => {
			const a = await h.mutations.add(s, login("x"));
			return h.mutations.touch(a, a.entries[0]!.id);
		},
	],
	[
		"setBreach",
		async (h: ReturnType<typeof harness>, s: VaultEntries) => {
			const a = await h.mutations.add(s, login("x"));
			return h.mutations.setBreach(a, a.entries[0]!.id, { leaked: false, checkedAt: 1 });
		},
	],
];

describe("createEntryMutations", () => {
	it("add stamps the new entry and writes once", async () => {
		const h = harness();
		const next = await h.mutations.add(empty(), login("a"));
		expect(next.entries).toHaveLength(1);
		const id = next.entries[0]!.id;
		expect(next.stamps.has(id)).toBe(true);
		expect(h.writes()).toBe(1);
	});

	it("import is a single disk write regardless of count", async () => {
		const h = harness();
		const next = await h.mutations.importMany(empty(), [login("a"), login("b"), login("c")]);
		expect(next.entries).toHaveLength(3);
		expect(next.stamps.size).toBe(3);
		expect(h.writes()).toBe(1);
	});

	it("delete writes a tombstone that survives a reload from disk", async () => {
		const h = harness();
		const afterAdd = await h.mutations.add(empty(), login("a"));
		const id = afterAdd.entries[0]!.id;
		const afterDel = await h.mutations.remove(afterAdd, id);
		expect(afterDel.entries).toHaveLength(0);
		expect(afterDel.stamps.has(id)).toBe(false);
		expect(afterDel.tombstones.has(id)).toBe(true);

		const payload = await h.mutations.readEntriesPayload();
		expect(payload.entries).toHaveLength(0);
		expect(payload.tombstones.map((t) => t.id)).toContain(id);
	});

	// The bulk-select path. Looping `remove` would re-encrypt and rewrite the whole
	// vault once per selected entry, so the batch has to collapse to one write.
	it("removeMany deletes the selection in a single disk write", async () => {
		const h = harness();
		const seeded = await h.mutations.importMany(empty(), [login("a"), login("b"), login("c")]);
		const [a, b, c] = seeded.entries.map((e) => e.id) as [string, string, string];
		const writesBefore = h.writes();

		const next = await h.mutations.removeMany(seeded, [a, c]);
		expect(next.entries.map((e) => e.id)).toEqual([b]);
		expect(h.writes()).toBe(writesBefore + 1);
	});

	it("removeMany tombstones every id it removed", async () => {
		const h = harness();
		const seeded = await h.mutations.importMany(empty(), [login("a"), login("b"), login("c")]);
		const [a, , c] = seeded.entries.map((e) => e.id) as [string, string, string];

		const next = await h.mutations.removeMany(seeded, [a, c]);
		expect(next.stamps.has(a)).toBe(false);
		expect(next.stamps.has(c)).toBe(false);
		// Distinct stamps, so a merge can order the two deletions against each other.
		expect(compareHlc(next.tombstones.get(c)!, next.tombstones.get(a)!)).toBe(1);

		const payload = await h.mutations.readEntriesPayload();
		expect(payload.entries).toHaveLength(1);
		expect(payload.tombstones.map((t) => t.id).sort()).toEqual([a, c].sort());
	});

	// An empty selection must not rewrite the vault just to change nothing.
	it("removeMany is a no-op for an empty selection", async () => {
		const h = harness();
		const seeded = await h.mutations.importMany(empty(), [login("a")]);
		const writesBefore = h.writes();
		const next = await h.mutations.removeMany(seeded, []);
		expect(next).toBe(seeded);
		expect(h.writes()).toBe(writesBefore);
	});

	it("update replaces the entry and advances its stamp", async () => {
		const h = harness();
		const afterAdd = await h.mutations.add(empty(), login("a"));
		const id = afterAdd.entries[0]!.id;
		const firstStamp = afterAdd.stamps.get(id)!;
		const afterUpd = await h.mutations.update(afterAdd, id, login("a2"));
		const secondStamp = afterUpd.stamps.get(id)!;
		expect(afterUpd.entries[0]!.name).toBe("a2");
		expect(compareHlc(secondStamp, firstStamp)).toBe(1);
	});

	it("add stamps createdAt and updatedAt from the clock", async () => {
		const h = harness();
		const next = await h.mutations.add(empty(), login("a"));
		const e = next.entries[0]!;
		expect(e.createdAt).toBe(1000);
		expect(e.updatedAt).toBe(1000);
		expect(e.lastUsedAt).toBeUndefined();
	});

	it("update keeps createdAt, bumps updatedAt, and preserves lastUsedAt", async () => {
		let t = 1000;
		const h = harness(() => t);
		const afterAdd = await h.mutations.add(empty(), login("a"));
		const id = afterAdd.entries[0]!.id;
		const afterUse = await h.mutations.touch(afterAdd, id);
		expect(afterUse.entries[0]!.lastUsedAt).toBe(1000);
		t = 5000;
		const afterUpd = await h.mutations.update(afterUse, id, login("a2"));
		const e = afterUpd.entries[0]!;
		expect(e.createdAt).toBe(1000);
		expect(e.updatedAt).toBe(5000);
		expect(e.lastUsedAt).toBe(1000);
	});

	it("touch bumps lastUsedAt without changing updatedAt", async () => {
		let t = 1000;
		const h = harness(() => t);
		const afterAdd = await h.mutations.add(empty(), login("a"));
		const id = afterAdd.entries[0]!.id;
		t = 200_000; // well past the coalesce window
		const afterUse = await h.mutations.touch(afterAdd, id);
		expect(afterUse.entries[0]!.lastUsedAt).toBe(200_000);
		expect(afterUse.entries[0]!.updatedAt).toBe(1000);
	});

	// A use is not an edit: restamping would let copying a password on one device silently
	// discard an edit made to the same entry on another before they synced.
	it("touch keeps the sync stamp, so an edit made elsewhere still wins the merge", async () => {
		let t = 1000;
		const h = harness(() => t);
		const afterAdd = await h.mutations.add(empty(), login("a"));
		const id = afterAdd.entries[0]!.id;
		const added = afterAdd.stamps.get(id)!;
		const [base] = (await h.mutations.readEntriesPayload()).entries;
		const remoteEdit = {
			...base!,
			ciphertext: "ct:edited elsewhere",
			hlc: { wall: 2000, counter: 0, node: "device-b" },
		};

		t = 200_000;
		const afterUse = await h.mutations.touch(afterAdd, id);
		expect(afterUse.entries[0]!.lastUsedAt).toBe(200_000);
		expect(compareHlc(afterUse.stamps.get(id)!, added)).toBe(0);

		const local = await h.mutations.readEntriesPayload();
		const merged = mergeEntriesPayload(local, { entries: [remoteEdit], tombstones: [] });
		expect(merged.entries).toEqual([remoteEdit]);
	});

	it("touch coalesces repeat uses within the window into one write", async () => {
		let t = 1000;
		const h = harness(() => t);
		const afterAdd = await h.mutations.add(empty(), login("a"));
		const id = afterAdd.entries[0]!.id;
		const afterUse1 = await h.mutations.touch(afterAdd, id);
		const writesAfterUse1 = h.writes();
		t = 31_000; // 30s later, inside the 60s window
		const afterUse2 = await h.mutations.touch(afterUse1, id);
		expect(afterUse2).toBe(afterUse1);
		expect(h.writes()).toBe(writesAfterUse1);
	});

	it("touch no-ops for an unknown id", async () => {
		const h = harness();
		const state = empty();
		const same = await h.mutations.touch(state, "nope");
		expect(same).toBe(state);
		expect(h.writes()).toBe(0);
	});

	// Opening a login re-checks a stale breach status and saves it; a restamp there would let
	// viewing an entry on one device overwrite an edit made to it on another.
	it("setBreach keeps the sync stamp and updatedAt", async () => {
		let t = 1000;
		const h = harness(() => t);
		const a = await h.mutations.add(empty(), login("a"));
		const id = a.entries[0]!.id;
		t = 9000;
		const next = await h.mutations.setBreach(a, id, { leaked: true, checkedAt: 9000 });
		expect(next.entries[0]).toMatchObject({
			breach: { leaked: true, checkedAt: 9000 },
			updatedAt: 1000,
		});
		expect(compareHlc(next.stamps.get(id)!, a.stamps.get(id)!)).toBe(0);
		const [onDisk] = (await h.mutations.readEntriesPayload()).entries;
		expect(onDisk!.ciphertext).toContain('"leaked":true');
	});

	it("setBreach no-ops for an unknown id or a non-login", async () => {
		const h = harness();
		const a = await h.mutations.add(empty(), note("n"));
		const writes = h.writes();
		const breach = { leaked: true, checkedAt: 1 };
		expect(await h.mutations.setBreach(a, "nope", breach)).toBe(a);
		expect(await h.mutations.setBreach(a, a.entries[0]!.id, breach)).toBe(a);
		expect(h.writes()).toBe(writes);
	});

	it("rejects invalid entry data before writing", async () => {
		const h = harness();
		const bad = { type: "login", name: "x" } as unknown as EntryData; // missing urls/username/password
		await expect(h.mutations.add(empty(), bad)).rejects.toThrow(/validation/);
		expect(h.writes()).toBe(0);
	});

	it("projects only logins and cards into the autofill index", async () => {
		const h = harness();
		await h.mutations.add(empty(), note("just a note"));
		expect(h.indexCalls).toHaveLength(1);
		expect(h.indexCalls[0]).toHaveLength(0); // notes never reach the index
	});

	it("logs the superseded password on a rotation, timestamped by the edit", async () => {
		let t = 1000;
		const h = harness(() => t);
		const afterAdd = await h.mutations.add(empty(), loginWith("a", { password: "old" }));
		const id = afterAdd.entries[0]!.id;
		t = 5000;
		const afterUpd = await h.mutations.update(afterAdd, id, loginWith("a", { password: "new" }));
		const e = afterUpd.entries[0]!;
		expect(e.type === "login" && e.passwordChangelog).toEqual([{ value: "old", changedAt: 5000 }]);
	});

	it("keeps the changelog across the encrypt/persist round trip", async () => {
		let t = 1000;
		const h = harness(() => t);
		const afterAdd = await h.mutations.add(empty(), loginWith("a", { password: "old" }));
		const id = afterAdd.entries[0]!.id;
		t = 5000;
		await h.mutations.update(afterAdd, id, loginWith("a", { password: "new" }));
		// The fake encryptEntry stores `ct:<json>`, so the blob carries the serialized entry.
		const payload = await h.mutations.readEntriesPayload();
		const json = payload.entries[0]!.ciphertext.slice("ct:".length);
		expect(JSON.parse(json).passwordChangelog).toEqual([{ value: "old", changedAt: 5000 }]);
	});

	it("logs nothing when an edit leaves the password alone", async () => {
		let t = 1000;
		const h = harness(() => t);
		const afterAdd = await h.mutations.add(empty(), loginWith("a", { password: "same" }));
		const id = afterAdd.entries[0]!.id;
		t = 5000;
		// Mirrors the breach-check write-back: same password, new metadata.
		const afterUpd = await h.mutations.update(
			afterAdd,
			id,
			loginWith("a", {
				password: "same",
				breach: { leaked: true, checkedAt: 5000 },
			}),
		);
		const e = afterUpd.entries[0]!;
		expect(e.type === "login" && e.passwordChangelog).toBeUndefined();
	});

	it("ignores a caller-supplied changelog and derives it from the stored entry", async () => {
		let t = 1000;
		const h = harness(() => t);
		const afterAdd = await h.mutations.add(empty(), loginWith("a", { password: "old" }));
		const id = afterAdd.entries[0]!.id;
		t = 5000;
		const afterUpd = await h.mutations.update(
			afterAdd,
			id,
			loginWith("a", {
				password: "new",
				passwordChangelog: [{ value: "forged", changedAt: 1 }],
			}),
		);
		const e = afterUpd.entries[0]!;
		expect(e.type === "login" && e.passwordChangelog).toEqual([{ value: "old", changedAt: 5000 }]);
	});

	it("survives an edit form that drops the changelog, the way it drops passkeys", async () => {
		let t = 1000;
		const h = harness(() => t);
		const afterAdd = await h.mutations.add(empty(), loginWith("a", { password: "old" }));
		const id = afterAdd.entries[0]!.id;
		t = 5000;
		const rotated = await h.mutations.update(afterAdd, id, loginWith("a", { password: "new" }));
		t = 9000;
		// `login()` builds fresh data with no changelog key at all.
		const renamed = await h.mutations.update(
			rotated,
			id,
			loginWith("renamed", { password: "new" }),
		);
		const e = renamed.entries[0]!;
		expect(e.type === "login" && e.passwordChangelog).toEqual([{ value: "old", changedAt: 5000 }]);
	});

	it("keeps the changelog when a use is recorded", async () => {
		let t = 1000;
		const h = harness(() => t);
		const afterAdd = await h.mutations.add(empty(), loginWith("a", { password: "old" }));
		const id = afterAdd.entries[0]!.id;
		t = 5000;
		const rotated = await h.mutations.update(afterAdd, id, loginWith("a", { password: "new" }));
		t = 200_000;
		const used = await h.mutations.touch(rotated, id);
		const e = used.entries[0]!;
		expect(e.type === "login" && e.passwordChangelog).toEqual([{ value: "old", changedAt: 5000 }]);
	});

	it("archive keeps the entry and writes no tombstone, so a restore is just the inverse", async () => {
		let t = 1000;
		const h = harness(() => t);
		const afterAdd = await h.mutations.add(empty(), login("a"));
		const id = afterAdd.entries[0]!.id;

		t = 5000;
		const archived = await h.mutations.setArchived(afterAdd, [id], true);
		expect(archived.entries).toHaveLength(1);
		expect(archived.entries[0]!.archivedAt).toBe(5000);
		expect(archived.tombstones.size).toBe(0);
		// A fresh stamp, or a peer would never learn the entry was archived.
		expect(compareHlc(archived.stamps.get(id)!, afterAdd.stamps.get(id)!)).toBeGreaterThan(0);

		t = 9000;
		const restored = await h.mutations.setArchived(archived, [id], false);
		// Deleted, not set to undefined: an explicitly-undefined key would serialize away
		// anyway, and the round-trip through disk must not resurrect the archived state.
		expect(restored.entries[0]).not.toHaveProperty("archivedAt");
		const payload = await h.mutations.readEntriesPayload();
		// The field is gone from the entry itself (its part stamp, recording the restore, stays).
		expect(
			payload.entries.map((e) => JSON.parse(e.ciphertext.slice(3)) as Record<string, unknown>),
		).toEqual([expect.not.objectContaining({ archivedAt: expect.anything() })]);
	});

	it("archives a whole selection in one write, skipping ids already archived", async () => {
		const h = harness();
		const seeded = await h.mutations.importMany(empty(), [login("a"), login("b"), login("c")]);
		const [a, b, c] = seeded.entries.map((e) => e.id) as [string, string, string];
		const first = await h.mutations.setArchived(seeded, [a], true);
		const writesBefore = h.writes();

		const both = await h.mutations.setArchived(first, [a, b], true);
		expect(h.writes()).toBe(writesBefore + 1);
		expect(both.entries.filter((e) => e.archivedAt !== undefined).map((e) => e.id)).toEqual([a, b]);
		expect(both.entries.find((e) => e.id === c)!.archivedAt).toBeUndefined();
		// `a` was already archived, so its stamp (and its archivedAt) is left alone.
		expect(both.stamps.get(a)).toEqual(first.stamps.get(a));
		expect(both.entries.find((e) => e.id === a)!.archivedAt).toBe(
			first.entries.find((e) => e.id === a)!.archivedAt,
		);
	});

	// A whole-vault re-encrypt is the cost of any persist, so a no-op must not trigger one.
	it("archiving nothing new writes nothing at all", async () => {
		const h = harness();
		const seeded = await h.mutations.add(empty(), login("a"));
		const id = seeded.entries[0]!.id;
		const archived = await h.mutations.setArchived(seeded, [id], true);
		const writesBefore = h.writes();

		expect(await h.mutations.setArchived(archived, [id], true)).toBe(archived);
		expect(await h.mutations.setArchived(archived, [], false)).toBe(archived);
		expect(await h.mutations.setArchived(archived, ["no-such-id"], true)).toBe(archived);
		expect(h.writes()).toBe(writesBefore);
	});

	it("drops an archived entry from the autofill index and puts it back on restore", async () => {
		const h = harness();
		const seeded = await h.mutations.importMany(empty(), [login("a"), login("b")]);
		const [a] = seeded.entries.map((e) => e.id) as [string, string];

		const archived = await h.mutations.setArchived(seeded, [a], true);
		expect(h.indexCalls.at(-1)).toHaveLength(1);

		await h.mutations.setArchived(archived, [a], false);
		expect(h.indexCalls.at(-1)).toHaveLength(2);
	});

	it("archiving does not touch updatedAt, so it can't reorder recently-updated", async () => {
		let t = 1000;
		const h = harness(() => t);
		const afterAdd = await h.mutations.add(empty(), login("a"));
		const id = afterAdd.entries[0]!.id;
		const updatedAt = afterAdd.entries[0]!.updatedAt;

		t = 5000;
		const archived = await h.mutations.setArchived(afterAdd, [id], true);
		expect(archived.entries[0]!.updatedAt).toBe(updatedAt);
	});

	it("adds a tag across a selection in one write, skipping entries that already have it", async () => {
		const h = harness();
		const seeded = await h.mutations.importMany(empty(), [login("a"), login("b"), login("c")]);
		const [a, b, c] = seeded.entries.map((e) => e.id) as [string, string, string];
		const first = await h.mutations.setTags(seeded, [a], { add: ["work"] });
		const writesBefore = h.writes();

		const both = await h.mutations.setTags(first, [a, b], { add: ["work"] });
		expect(h.writes()).toBe(writesBefore + 1);
		expect(both.entries.find((e) => e.id === a)?.tags).toEqual(["work"]);
		expect(both.entries.find((e) => e.id === b)?.tags).toEqual(["work"]);
		expect(both.entries.find((e) => e.id === c)?.tags).toBeUndefined();
		// `a` already had it, so its stamp is untouched.
		expect(both.stamps.get(a)).toEqual(first.stamps.get(a));
	});

	it("removes a tag by key, so 'work' also takes off 'Work'", async () => {
		const h = harness();
		const seeded = await h.mutations.importMany(empty(), [login("a")]);
		const id = seeded.entries[0]!.id;
		const tagged = await h.mutations.setTags(seeded, [id], { add: ["Work", "bank"] });
		const untagged = await h.mutations.setTags(tagged, [id], { remove: ["work"] });
		expect(untagged.entries[0]?.tags).toEqual(["bank"]);
	});

	it("drops the key entirely when the last tag comes off", async () => {
		const h = harness();
		const seeded = await h.mutations.importMany(empty(), [login("a")]);
		const id = seeded.entries[0]!.id;
		const tagged = await h.mutations.setTags(seeded, [id], { add: ["work"] });
		const untagged = await h.mutations.setTags(tagged, [id], { remove: ["work"] });
		expect(untagged.entries[0]).not.toHaveProperty("tags");
		expect(JSON.stringify(await h.mutations.readEntriesPayload())).not.toContain("tags");
	});

	// A persist re-encrypts the whole vault, so a change that changes nothing must not run.
	it("writes nothing when the tag change is a no-op", async () => {
		const h = harness();
		const seeded = await h.mutations.importMany(empty(), [login("a")]);
		const id = seeded.entries[0]!.id;
		const tagged = await h.mutations.setTags(seeded, [id], { add: ["work"] });
		const writesBefore = h.writes();

		expect(await h.mutations.setTags(tagged, [id], { add: ["work"] })).toBe(tagged);
		expect(await h.mutations.setTags(tagged, [id], { remove: ["nope"] })).toBe(tagged);
		expect(await h.mutations.setTags(tagged, [id], {})).toBe(tagged);
		expect(await h.mutations.setTags(tagged, ["no-such-id"], { add: ["x"] })).toBe(tagged);
		expect(h.writes()).toBe(writesBefore);
	});

	it("tagging does not touch updatedAt, so a bulk tag can't reorder recently-updated", async () => {
		let t = 1000;
		const h = harness(() => t);
		const afterAdd = await h.mutations.add(empty(), login("a"));
		const id = afterAdd.entries[0]!.id;
		const updatedAt = afterAdd.entries[0]!.updatedAt;
		t = 5000;
		const tagged = await h.mutations.setTags(afterAdd, [id], { add: ["work"] });
		expect(tagged.entries[0]!.updatedAt).toBe(updatedAt);
	});

	// The import path is the only way archived/tagged entries enter a vault in bulk, and
	// it is a different code path from `add`: it validates a batch, then persists once.
	it("import preserves archivedAt and tags through the write and back off disk", async () => {
		const h = harness();
		const next = await h.mutations.importMany(empty(), [
			{ ...loginWith("archived-one"), archivedAt: 5000, tags: ["work"] },
			loginWith("live-one"),
		]);
		expect(next.entries[0]?.archivedAt).toBe(5000);
		expect(next.entries[0]?.tags).toEqual(["work"]);
		expect(next.entries[1]?.archivedAt).toBeUndefined();

		const payload = await h.mutations.readEntriesPayload();
		expect(JSON.stringify(payload)).toContain("archivedAt");
		expect(JSON.stringify(payload)).toContain("work");
	});

	it("keeps an imported archived entry out of the autofill index", async () => {
		const h = harness();
		await h.mutations.importMany(empty(), [
			{ ...loginWith("archived-one"), archivedAt: 5000 },
			loginWith("live-one"),
		]);
		expect(h.indexCalls.at(-1)).toHaveLength(1);
	});

	it("never leaks a superseded password into the autofill index", async () => {
		let t = 1000;
		const h = harness(() => t);
		const afterAdd = await h.mutations.add(empty(), loginWith("a", { password: "old" }));
		const id = afterAdd.entries[0]!.id;
		t = 5000;
		await h.mutations.update(afterAdd, id, loginWith("a", { password: "new" }));
		const latest = h.indexCalls.at(-1)!;
		expect(JSON.stringify(latest)).not.toContain("old");
	});
});

// Confidence test 2 from docs/synced-settings.md, and the highest-risk seam in that change.
// buildPayload rebuilds the whole payload from VaultEntries on every write, so without threading
// the settings map through it, ANY entry edit silently wipes every synced setting. The failure is
// invisible locally: the value is still on screen from memory, and only reverts on reload or when
// a peer merges the emptied payload back.
describe("createEntryMutations: synced settings survive entry writes", () => {
	const elsewhere: EncryptedEntry = {
		id: "elsewhere",
		wrappedDek: "w",
		dekIv: "d",
		ciphertext: "s",
		iv: "i",
		hlc: { wall: 400, counter: 0, node: "other" },
		vv: { other: { wall: 400, counter: 0, node: "other" } },
	};
	const withSetting = (): VaultEntries => ({
		...empty(),
		conflicts: [elsewhere],
		settings: {
			"pref.aliasProvider": {
				hlc: { wall: 500, counter: 0, node: "other" },
				value: { provider: "addy" },
			},
		},
	});

	/** What actually reached the disk, so this cannot pass on in-memory state alone. */
	async function onDisk(h: ReturnType<typeof harness>) {
		return (await h.mutations.readEntriesPayload()).settings;
	}

	// Every mutation, not a hand-picked few: each one rebuilds the state it hands to persist, so
	// each is its own chance to drop the map. `touch` is the sharpest of them, since it fires on
	// every copy and every fill.
	it.each(ENTRY_MUTATIONS)("%s preserves the map, in memory and on disk", async (_name, run) => {
		const h = harness();
		const next = await run(h, withSetting());
		expect(next.settings).toEqual(withSetting().settings);
		expect(await onDisk(h)).toEqual(withSetting().settings);
		// Another entry's sibling versions ride every write the same way.
		expect(next.conflicts).toEqual([elsewhere]);
		expect((await h.mutations.readEntriesPayload()).conflicts).toEqual([elsewhere]);
	});

	it("add preserves the map", async () => {
		const h = harness();
		const next = await h.mutations.add(withSetting(), login("a"));
		expect(next.settings?.["pref.aliasProvider"]?.value).toEqual({ provider: "addy" });
		expect(await onDisk(h)).toEqual(withSetting().settings);
	});

	it("update preserves the map", async () => {
		const h = harness();
		const added = await h.mutations.add(withSetting(), login("a"));
		const id = added.entries[0]!.id;
		const next = await h.mutations.update(added, id, login("renamed"));
		expect(await onDisk(h)).toEqual(withSetting().settings);
		expect(next.settings).toEqual(withSetting().settings);
	});

	it("delete preserves the map", async () => {
		const h = harness();
		const added = await h.mutations.add(withSetting(), login("a"));
		await h.mutations.remove(added, added.entries[0]!.id);
		expect(await onDisk(h)).toEqual(withSetting().settings);
	});

	it("import preserves the map", async () => {
		const h = harness();
		await h.mutations.importMany(withSetting(), [login("a"), login("b")]);
		expect(await onDisk(h)).toEqual(withSetting().settings);
	});

	// A vault with no settings must not grow an empty map, or every payload gains a key that
	// means nothing and older clients see a change where there was none.
	it("leaves the map absent when there is none", async () => {
		const h = harness();
		await h.mutations.add(empty(), login("a"));
		expect(await onDisk(h)).toBeUndefined();
	});

	// The write path for a setting: stamped from this device's clock, and persisted.
	it("setSetting stamps and writes the value", async () => {
		const h = harness();
		const next = await h.mutations.setSetting(empty(), "pref.aliasProvider", { provider: "addy" });
		const rec = next.settings?.["pref.aliasProvider"];
		expect(rec?.value).toEqual({ provider: "addy" });
		expect(rec?.hlc.node).toBe("device-a");
		expect(await onDisk(h)).toEqual(next.settings);
	});

	// Clearing is an explicit null carrying a stamp, never removal of the key: absence is what a
	// client predating the map produces, so it cannot also mean "the user turned this off".
	it("setSetting records a clear as a stamped null", async () => {
		const h = harness();
		const set = await h.mutations.setSetting(empty(), "pref.aliasProvider", { provider: "addy" });
		const cleared = await h.mutations.setSetting(set, "pref.aliasProvider", null);
		const rec = cleared.settings?.["pref.aliasProvider"];
		expect(rec?.value).toBeNull();
		expect(compareHlc(rec!.hlc, set.settings!["pref.aliasProvider"]!.hlc)).toBeGreaterThan(0);
	});

	it("setSetting leaves entries untouched", async () => {
		const h = harness();
		const added = await h.mutations.add(empty(), login("a"));
		const next = await h.mutations.setSetting(added, "pref.aliasProvider", { provider: "addy" });
		expect(next.entries).toEqual(added.entries);
		expect(next.stamps).toEqual(added.stamps);
	});
});

// The same seam as the synced-settings suite above, for the file manifest. buildPayload rebuilds
// the payload from VaultEntries on every write, so a manifest not threaded through is erased by
// ANY entry edit: attach a passport scan, rename an unrelated login, and the attachment is gone
// from disk while still on screen from memory. See docs/file-attachments.md.
describe("createEntryMutations: the file manifest survives entry writes", () => {
	const manifest = (): FileManifest => ({
		files: [
			fileRecord({
				hlc: { wall: 500, counter: 0, node: "other" },
				entryId: "some-entry",
				hash: "c".repeat(64),
				size: 262160,
			}),
		],
		fileTombstones: [{ id: "f2", hlc: { wall: 400, counter: 0, node: "other" } }],
		fileCascades: [{ id: "f3", hlc: { wall: 450, counter: 0, node: "other" } }],
	});
	const withManifest = (): VaultEntries => ({ ...empty(), manifest: manifest() });

	/** What actually reached the disk, so this cannot pass on in-memory state alone. */
	async function onDisk(h: ReturnType<typeof harness>): Promise<FileManifest> {
		const payload = await h.mutations.readEntriesPayload();
		return {
			files: payload.files,
			fileTombstones: payload.fileTombstones,
			fileCascades: payload.fileCascades,
		};
	}

	it.each([
		...ENTRY_MUTATIONS,
		[
			"setSetting",
			async (h: ReturnType<typeof harness>, s: VaultEntries) =>
				h.mutations.setSetting(s, "pref.theme", "dark"),
		],
	])("%s preserves the manifest, in memory and on disk", async (_name, run) => {
		const h = harness();
		const next = await run(h, withManifest());
		expect(next.manifest).toEqual(manifest());
		expect(await onDisk(h)).toEqual(manifest());
	});

	// A vault with no files must not grow two empty arrays, or every payload written by every
	// existing install gains keys it has no use for.
	it("a vault with no files keeps the payload shape it already has", async () => {
		const h = harness();
		await h.mutations.add(empty(), login("x"));
		const payload = await h.mutations.readEntriesPayload();
		expect(payload).not.toHaveProperty("files");
		expect(payload).not.toHaveProperty("fileTombstones");
	});

	it("the manifest and synced settings survive the same write", async () => {
		const h = harness();
		const start: VaultEntries = {
			...empty(),
			manifest: manifest(),
			settings: { "pref.x": { hlc: { wall: 1, counter: 0, node: "n" }, value: 1 } },
		};
		await h.mutations.add(start, login("x"));
		const payload = await h.mutations.readEntriesPayload();
		expect(payload.files).toEqual(manifest().files);
		expect(payload.settings).toEqual(start.settings);
	});
});

// Each write records which versions it supersedes (docs/sync-conflicts.md, Phase A): an edit only
// the displayed one, a delete every version it can see, and nothing written may drop siblings.
describe("createEntryMutations: version history", () => {
	const at = (wall: number, node: string): Hlc => ({ wall, counter: 0, node });
	const sib = (id: string, wall: number, node = "other"): EncryptedEntry => ({
		id,
		wrappedDek: "old-wd",
		dekIv: "d",
		ciphertext: 'ct:{"type":"note","name":"sibling"}',
		iv: "i",
		hlc: at(wall, node),
		vv: { [node]: at(wall, node) },
	});
	const versionOf = (s: VaultEntries, id: string) => ({
		hlc: s.stamps.get(id)!,
		...s.causal.get(id),
	});

	it("add stamps a version of its own", async () => {
		const h = harness();
		const a = await h.mutations.add(empty(), login("a"));
		const id = a.entries[0]!.id;
		expect(a.causal.get(id)).toEqual({ vv: { "device-a": a.stamps.get(id) } });
		const [onDisk] = (await h.mutations.readEntriesPayload()).entries;
		expect(onDisk!.vv).toEqual({ "device-a": a.stamps.get(id) });
	});

	it("update supersedes only the displayed version", async () => {
		const h = harness();
		const a = await h.mutations.add(empty(), login("a"));
		const id = a.entries[0]!.id;
		const seeded = { ...a, conflicts: [sib(id, 500)] };
		const next = await h.mutations.update(seeded, id, login("a2"));
		expect(next.conflicts).toEqual([sib(id, 500)]);
		expect(isAncestor(versionOf(a, id), versionOf(next, id))).toBe(true);
		expect(isAncestor(sib(id, 500), versionOf(next, id))).toBe(false);
		const disk = await h.mutations.readEntriesPayload();
		expect(disk.conflicts).toEqual([sib(id, 500)]);
		expect(disk.entries[0]!.vv).toEqual(next.causal.get(id)!.vv);
	});

	it("an edit around this device's own sibling is stamped under its fork key", async () => {
		const h = harness();
		const a = await h.mutations.add(empty(), login("a"));
		const id = a.entries[0]!.id;
		// The phone's version is shown; this device's own earlier edit is the sibling.
		const seeded: VaultEntries = {
			...a,
			stamps: new Map([[id, at(5000, "phone")]]),
			causal: new Map([[id, { vv: { phone: at(5000, "phone") } }]]),
			conflicts: [{ ...sib(id, 3000, "device-a") }],
		};
		const next = await h.mutations.update(seeded, id, login("a2"));
		const stamp = next.stamps.get(id)!;
		expect(stamp.node.startsWith("device-a~")).toBe(true);
		expect(next.causal.get(id)!.vv[stamp.node]).toEqual(stamp);
		expect(next.conflicts).toHaveLength(1);
	});

	it("update of an entry with a legacy version inherits its floor", async () => {
		const h = harness();
		const a = await h.mutations.add(empty(), login("a"));
		const id = a.entries[0]!.id;
		const next = await h.mutations.update({ ...a, causal: new Map() }, id, login("a2"));
		expect(next.causal.get(id)!.floor).toEqual(a.stamps.get(id));
	});

	it("archiving and tagging supersede only the displayed version", async () => {
		const h = harness();
		const a = await h.mutations.add(empty(), login("a"));
		const id = a.entries[0]!.id;
		const seeded = { ...a, conflicts: [sib(id, 500)] };
		const archived = await h.mutations.setArchived(seeded, [id], true);
		expect(archived.conflicts).toEqual([sib(id, 500)]);
		expect(archived.causal.get(id)?.floor).toBeUndefined();
		expect(isAncestor(versionOf(a, id), versionOf(archived, id))).toBe(true);
		expect(isAncestor(sib(id, 500), versionOf(archived, id))).toBe(false);
		const tagged = await h.mutations.setTags(archived, [id], { add: ["work"] });
		expect(tagged.conflicts).toEqual([sib(id, 500)]);
		expect(isAncestor(versionOf(archived, id), versionOf(tagged, id))).toBe(true);
		expect(isAncestor(sib(id, 500), versionOf(tagged, id))).toBe(false);
	});

	it("remove supersedes every sibling and the old tombstone", async () => {
		const h = harness();
		const a = await h.mutations.add(empty(), login("a"));
		const id = a.entries[0]!.id;
		const oldTomb = { hlc: at(300, "z"), vv: { z: at(300, "z") } };
		const seeded: VaultEntries = {
			...a,
			conflicts: [sib(id, 500), sib("other-id", 600)],
			tombstones: new Map([[id, oldTomb.hlc]]),
			tombstoneCausal: new Map([[id, { vv: oldTomb.vv }]]),
		};
		const next = await h.mutations.remove(seeded, id);
		expect(next.conflicts).toEqual([sib("other-id", 600)]);
		expect(next.causal.has(id)).toBe(false);
		const tomb = { hlc: next.tombstones.get(id)!, ...next.tombstoneCausal.get(id) };
		expect(containsHistory(tomb, sib(id, 500))).toBe(true);
		expect(containsHistory(tomb, versionOf(a, id))).toBe(true);
		expect(containsHistory(tomb, oldTomb)).toBe(true);
		const disk = await h.mutations.readEntriesPayload();
		expect(disk.tombstones.find((t) => t.id === id)!.vv).toEqual(tomb.vv);
	});

	it("a write keeps other entries' history on disk", async () => {
		const h = harness();
		const a = await h.mutations.add(empty(), login("a"));
		const b = await h.mutations.add(a, login("b"));
		const [idA, idB] = b.entries.map((e) => e.id) as [string, string];
		await h.mutations.update(b, idB, login("b2"));
		const disk = await h.mutations.readEntriesPayload();
		expect(disk.entries.find((e) => e.id === idA)!.vv).toEqual(b.causal.get(idA)!.vv);
	});

	// Rotation opens the siblings while the old key still exists, then re-seals them under the new
	// one: sealAll runs after the old key is gone, so it can't open them itself.
	it("sealAll re-seals conflicts from plaintext opened before the key rotated", async () => {
		const h = harness();
		const a = await h.mutations.add(empty(), login("a"));
		const id = a.entries[0]!.id;
		const seeded = { ...a, conflicts: [sib(id, 500)] };
		const opened = await h.mutations.openConflicts(seeded);
		expect(opened).toEqual(['{"type":"note","name":"sibling"}']);
		const sealed = await h.mutations.sealAll(seeded, opened);
		const json = new TextDecoder().decode(sealed.entriesCiphertext);
		const payload: EntriesPayload = decodeEntriesPayload(json);
		expect(payload.conflicts).toHaveLength(1);
		expect(payload.conflicts![0]).toMatchObject({
			id,
			hlc: sib(id, 500).hlc,
			vv: sib(id, 500).vv,
			wrappedDek: "wd",
			ciphertext: 'ct:{"type":"note","name":"sibling"}',
		});
	});

	it("vaultEntriesFromPayload keeps vv, floor and conflicts, and stamps only what decrypted", () => {
		const env = (id: string, hlc: Hlc, extra: object = {}): EncryptedEntry => ({
			id,
			wrappedDek: "w",
			dekIv: "d",
			ciphertext: "c",
			iv: "i",
			hlc,
			...extra,
		});
		const payload: EntriesPayload = {
			entries: [
				env("a", at(10, "n"), { vv: { n: at(10, "n") }, floor: at(5, "q") }),
				env("b", at(20, "n")),
				env("gone", at(30, "n")),
			],
			tombstones: [
				{ id: "t", hlc: at(3, "n"), vv: { n: at(3, "n") } },
				{ id: "u", hlc: at(4, "n") },
			],
			conflicts: [sib("a", 1)],
		};
		const decrypted = [
			{ id: "a", type: "note", name: "a" },
			{ id: "b", type: "note", name: "b" },
		] as Entry[];
		const state = vaultEntriesFromPayload(payload, decrypted);
		expect(state.entries).toBe(decrypted);
		expect([...state.stamps.keys()]).toEqual(["a", "b"]);
		expect(state.causal.get("a")).toEqual({ vv: { n: at(10, "n") }, floor: at(5, "q") });
		expect(state.causal.has("b")).toBe(false);
		expect(state.tombstoneCausal.get("t")).toEqual({ vv: { n: at(3, "n") } });
		expect(state.tombstoneCausal.has("u")).toBe(false);
		expect(state.conflicts).toEqual(payload.conflicts);
	});

	it("conflictsOf reports siblings and concurrent deletes from memory", async () => {
		const h = harness();
		const a = await h.mutations.add(empty(), login("a"));
		const id = a.entries[0]!.id;
		expect(conflictsOf(a).size).toBe(0);
		expect(conflictsOf({ ...a, conflicts: [sib(id, 500)] }).get(id)).toEqual({
			versions: 1,
			deleted: false,
		});
		const concurrentDelete: VaultEntries = {
			...a,
			tombstones: new Map([[id, at(400, "z")]]),
			tombstoneCausal: new Map([[id, { vv: { z: at(400, "z") } }]]),
		};
		expect(conflictsOf(concurrentDelete).get(id)).toEqual({ versions: 0, deleted: true });
	});
});

// A resolution supersedes every version held for the entry, siblings and tombstone alike, so the
// conflict disappears on every device it reaches (docs/sync-conflicts.md).
describe("createEntryMutations: resolving a conflict", () => {
	const at = (wall: number, node: string): Hlc => ({ wall, counter: 0, node });
	const sib = (id: string): EncryptedEntry => ({
		id,
		wrappedDek: "w",
		dekIv: "d",
		ciphertext: "s",
		iv: "i",
		hlc: at(500, "other"),
		vv: { other: at(500, "other") },
	});
	const conflicted = async (
		h: ReturnType<typeof harness>,
		data = loginWith("a", { password: "mine" }),
	) => {
		const a = await h.mutations.add(empty(), data);
		const id = a.entries[0]!.id;
		const state: VaultEntries = {
			...a,
			conflicts: [sib(id)],
			tombstones: new Map([[id, at(400, "z")]]),
			tombstoneCausal: new Map([[id, { vv: { z: at(400, "z") } }]]),
		};
		return { state, id };
	};
	const versionOf = (s: VaultEntries, id: string) => ({
		hlc: s.stamps.get(id)!,
		...s.causal.get(id),
	});

	it("keep supersedes every sibling and the tombstone with the displayed content", async () => {
		const h = harness();
		const { state, id } = await conflicted(h);
		expect(conflictsOf(state).get(id)).toEqual({ versions: 1, deleted: true });
		const next = await h.mutations.resolve(state, id, { kind: "keep", superseded: [] });
		expect(next.conflicts).toEqual([]);
		expect(conflictsOf(next).size).toBe(0);
		const content = (e: Entry) => {
			const rest: Record<string, unknown> = { ...e };
			for (const f of PART_STAMP_FIELDS) delete rest[f];
			return rest;
		};
		expect(next.entries.map(content)).toEqual(state.entries.map(content));
		expect(containsHistory(versionOf(next, id), sib(id))).toBe(true);
		expect(next.tombstones.has(id)).toBe(true);
		const disk = await h.mutations.readEntriesPayload();
		expect(disk.conflicts).toBeUndefined();
	});

	// Keeping a version over a delete restores everything the delete removed: each part and item
	// it keeps is a choice made now, not the old write's (docs/sync-conflicts.md, Part stamps).
	it("keeping a version over a delete restamps everything it keeps", async () => {
		let t = 1000;
		const h = harness(() => t);
		const { state, id } = await conflicted(h, loginWith("a", { tags: ["work"], notes: "n" }));
		t = 2000;
		const next = await h.mutations.resolve(state, id, { kind: "keep", superseded: [] });
		const stamp = next.stamps.get(id)!;
		const kept = eff(next.entries[0]!);
		expect(new Set(Object.values(kept.parts))).toEqual(new Set([stamp]));
		expect(Object.values(kept.items.tags)).toEqual([stamp]);
	});

	it("use writes the sibling's content and keeps the displayed password in the changelog", async () => {
		let t = 1000;
		const h = harness(() => t);
		const { state, id } = await conflicted(h);
		t = 2000;
		const theirs = loginWith("a", { password: "theirs" });
		const next = await h.mutations.resolve(state, id, {
			kind: "use",
			data: theirs,
			superseded: [state.entries[0]!, theirs],
		});
		const e = next.entries[0]!;
		expect(e.type === "login" && e.password).toBe("theirs");
		expect(e.type === "login" && e.passwordChangelog?.map((c) => c.value)).toEqual(["mine"]);
		expect(e.updatedAt).toBe(2000);
		expect(next.conflicts).toEqual([]);
	});

	it("keepBoth adds the sibling as a new entry and resolves the original", async () => {
		const h = harness();
		const { state, id } = await conflicted(h);
		const writes = h.writes();
		const next = await h.mutations.resolve(state, id, {
			kind: "keepBoth",
			data: note("other"),
			superseded: [],
		});
		expect(h.writes()).toBe(writes + 1);
		expect(next.entries.map((e) => e.name)).toEqual(["a", "other"]);
		expect(next.entries[1]!.id).not.toBe(id);
		expect(next.conflicts).toEqual([]);
		expect(conflictsOf(next).size).toBe(0);
	});

	it("resolve is one write and no-ops for an entry that isn't shown", async () => {
		const h = harness();
		const { state, id } = await conflicted(h);
		const writes = h.writes();
		await h.mutations.resolve(state, id, { kind: "keep", superseded: [] });
		expect(h.writes()).toBe(writes + 1);
		expect(await h.mutations.resolve(state, "nope", { kind: "keep", superseded: [] })).toBe(state);
	});

	// Resolving must not lose a credential: every discarded version's password, and its own
	// changelog rows, go into the kept entry's changelog (final review, finding B2).
	it("keep folds a discarded version's password and changelog into the changelog", async () => {
		let t = 1000;
		const h = harness(() => t);
		const { state, id } = await conflicted(h);
		t = 3000;
		const theirs = loginWith("a", {
			password: "theirs",
			passwordChangelog: [{ value: "older-theirs", changedAt: 1500 }],
		});
		const next = await h.mutations.resolve(state, id, { kind: "keep", superseded: [theirs] });
		const e = next.entries[0]!;
		expect(e.type === "login" && e.password).toBe("mine");
		expect(e.type === "login" && e.passwordChangelog?.map((c) => c.value)).toEqual([
			"theirs",
			"older-theirs",
		]);
	});

	it("use keeps the chosen version's own changelog as well as the shown password", async () => {
		let t = 1000;
		const h = harness(() => t);
		const { state, id } = await conflicted(h);
		t = 3000;
		const theirs = loginWith("a", {
			password: "theirs",
			passwordChangelog: [{ value: "phone-interim", changedAt: 2000 }],
		});
		const next = await h.mutations.resolve(state, id, {
			kind: "use",
			data: theirs,
			superseded: [state.entries[0]!, theirs],
		});
		const values =
			next.entries[0]!.type === "login"
				? next.entries[0]!.passwordChangelog?.map((c) => c.value)
				: [];
		expect(values).toEqual(["mine", "phone-interim"]);
	});
});

// Every write records which parts it changed (docs/sync-conflicts.md, Phase B), so two devices'
// edits to different parts can later combine.
describe("createEntryMutations: part stamps", () => {
	const at = (wall: number, node = "device-a"): Hlc => ({ wall, counter: 0, node });
	const stampOf = (s: VaultEntries, id: string) => s.stamps.get(id)!;

	it("add and import stamp every part at the write's stamp", async () => {
		let t = 1000;
		const h = harness(() => t);
		const a = await h.mutations.add(empty(), loginWith("a", { tags: ["work"] }));
		const e = a.entries[0]!;
		const s = stampOf(a, e.id);
		expect(eff(e).parts).toEqual({ name: s, credential: s });
		expect(eff(e).items.tags).toEqual({ work: s });
		expect(e.partStampsAt).toEqual(s);
		t = 2000;
		const foreign = {
			...loginWith("b"),
			partStamps: { name: at(1, "elsewhere") },
			partStampsAt: at(1, "elsewhere"),
		};
		const imported = await h.mutations.importMany(a, [foreign as EntryData]);
		const b = imported.entries[1]!;
		expect(eff(b).parts.name).toEqual(stampOf(imported, b.id));
		expect(b.partStampsAt).toEqual(stampOf(imported, b.id));
	});

	it("update restamps only the parts it changed", async () => {
		let t = 1000;
		const h = harness(() => t);
		const a = await h.mutations.add(empty(), loginWith("a", { notes: "x" }));
		const id = a.entries[0]!.id;
		const first = stampOf(a, id);
		t = 2000;
		const next = await h.mutations.update(a, id, loginWith("a", { notes: "y" }));
		const second = stampOf(next, id);
		expect(eff(next.entries[0]!).parts).toEqual({ name: first, notes: second, credential: first });
		expect(next.entries[0]!.partStampsAt).toEqual(second);
		const [onDisk] = (await h.mutations.readEntriesPayload()).entries;
		expect(onDisk!.ciphertext).toContain('"partStampsAt"');
	});

	it("archive stamps archivedAt and tagging stamps the tags it added", async () => {
		let t = 1000;
		const h = harness(() => t);
		const a = await h.mutations.add(empty(), loginWith("a"));
		const id = a.entries[0]!.id;
		const first = stampOf(a, id);
		t = 2000;
		const archived = await h.mutations.setArchived(a, [id], true);
		expect(eff(archived.entries[0]!).parts.archivedAt).toEqual(stampOf(archived, id));
		expect(eff(archived.entries[0]!).parts.name).toEqual(first);
		t = 3000;
		const tagged = await h.mutations.setTags(archived, [id], { add: ["work"] });
		expect(eff(tagged.entries[0]!).items.tags).toEqual({ work: stampOf(tagged, id) });
		expect(tagged.entries[0]!.partStampsAt).toEqual(stampOf(tagged, id));
	});

	it("resolve keeps the kept content's stamps and sets partStampsAt to the new stamp", async () => {
		let t = 1000;
		const h = harness(() => t);
		const a = await h.mutations.add(empty(), loginWith("a"));
		const id = a.entries[0]!.id;
		const first = stampOf(a, id);
		t = 2000;
		const next = await h.mutations.resolve(a, id, { kind: "keep", superseded: [] });
		expect(next.entries[0]!.partStamps).toEqual({ name: first, credential: first });
		expect(next.entries[0]!.partStampsAt).toEqual(stampOf(next, id));
	});

	it("resolve restamps the parts a superseded version disagreed with", async () => {
		let t = 1000;
		const h = harness(() => t);
		const a = await h.mutations.add(empty(), loginWith("a"));
		const id = a.entries[0]!.id;
		const first = stampOf(a, id);
		t = 2000;
		const kept = await h.mutations.resolve(a, id, {
			kind: "keep",
			superseded: [loginWith("a", { notes: "theirs" })],
		});
		expect(eff(kept.entries[0]!).parts).toEqual({
			name: first,
			credential: first,
			notes: stampOf(kept, id),
		});
		t = 3000;
		// Keeping both: the chosen version became a copy, so the original chose against it too.
		const both = await h.mutations.resolve(a, id, {
			kind: "keepBoth",
			data: loginWith("b"),
			superseded: [],
		});
		expect(eff(both.entries[0]!).parts.name).toEqual(stampOf(both, id));
	});

	it("an edit around its own sibling stamps parts with its fork-key stamp", async () => {
		const h = harness();
		const a = await h.mutations.add(empty(), loginWith("a"));
		const id = a.entries[0]!.id;
		const seeded: VaultEntries = {
			...a,
			stamps: new Map([[id, at(5000, "phone")]]),
			causal: new Map([[id, { vv: { phone: at(5000, "phone") } }]]),
			conflicts: [
				{
					id,
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "s",
					iv: "i",
					hlc: at(3000),
					vv: { "device-a": at(3000) },
				},
			],
		};
		const next = await h.mutations.update(seeded, id, loginWith("a2"));
		const stamp = stampOf(next, id);
		expect(stamp.node.startsWith("device-a~")).toBe(true);
		expect(eff(next.entries[0]!).parts.name).toEqual(stamp);
		expect(next.entries[0]!.partStampsAt).toEqual(stamp);
	});
});

// The edit form keeps the values it opened with, so its save supersedes the version it opened,
// not whatever is displayed by then (docs/sync-conflicts.md, "Saving the edit form").
describe("createEntryMutations: saving from the version the form opened", () => {
	const at = (wall: number, node: string): Hlc => ({ wall, counter: 0, node });

	/** `id` written here as A, then replaced by the phone's B the way a sync would. */
	async function openedThenReplaced() {
		let t = 1000;
		const h = harness(() => t);
		const a = await h.mutations.add(empty(), loginWith("a"));
		const id = a.entries[0]!.id;
		const opened: OpenedVersion = {
			hlc: a.stamps.get(id)!,
			...a.causal.get(id),
			data: a.entries[0]!,
		};
		const theirs = at(2000, "phone");
		const shown = a.entries[0]!;
		const replaced: VaultEntries = {
			...a,
			entries: [
				{
					...shown,
					notes: "theirs",
					partStamps: { ...shown.partStamps, notes: theirs },
					partStampsAt: theirs,
				} as Entry,
			],
			stamps: new Map([[id, theirs]]),
			causal: new Map([[id, { vv: { ...a.causal.get(id)!.vv, phone: theirs } }]]),
		};
		t = 3000;
		return { h, a, id, opened, replaced, theirs };
	}

	it("a save from a version no longer displayed becomes a sibling of the one that is", async () => {
		const { h, id, opened, replaced, theirs } = await openedThenReplaced();
		const next = await h.mutations.update(
			replaced,
			id,
			loginWith("a", { password: "mine" }),
			opened,
		);
		const save = { hlc: next.stamps.get(id)!, ...next.causal.get(id) };
		expect(next.entries[0]).toMatchObject({ password: "mine" });
		expect(next.conflicts.map((e) => e.hlc)).toEqual([theirs]);
		expect(JSON.parse(next.conflicts[0]!.ciphertext.slice(3))).toMatchObject({ notes: "theirs" });
		expect(next.conflicts[0]!.vv).toEqual(replaced.causal.get(id)!.vv);
		expect(isAncestor(opened, save)).toBe(true);
		expect(isAncestor({ hlc: theirs, ...replaced.causal.get(id) }, save)).toBe(false);
		expect(conflictsOf(next).get(id)).toEqual({ versions: 1, deleted: false });
		const onDisk = await h.mutations.readEntriesPayload();
		expect(onDisk.conflicts?.map((e) => e.hlc)).toEqual([theirs]);
	});

	it("refuses a version opened on another entry", async () => {
		const { h, a, id, opened } = await openedThenReplaced();
		const elsewhere = { ...opened, data: { ...opened.data, id: "another-entry" } };
		await expect(h.mutations.update(a, id, loginWith("a"), elsewhere)).rejects.toThrow();
	});

	it("a save from the displayed version works as before", async () => {
		const { h, a, id, opened } = await openedThenReplaced();
		const next = await h.mutations.update(a, id, loginWith("a", { password: "mine" }), opened);
		expect(next.conflicts).toEqual([]);
		expect(isAncestor(opened, { hlc: next.stamps.get(id)!, ...next.causal.get(id) })).toBe(true);
	});

	it("the save restamps only parts it changed relative to the version opened", async () => {
		const { h, id, opened, replaced } = await openedThenReplaced();
		const next = await h.mutations.update(
			replaced,
			id,
			loginWith("a", { password: "mine" }),
			opened,
		);
		const saved = next.entries[0] as Entry & LoginEntryData;
		expect(eff(saved).parts).toEqual({ name: opened.hlc, credential: next.stamps.get(id) });
		expect(saved.passwordChangelog?.map((c) => c.value)).toEqual(["p"]);
	});

	it("a save from a version that became a sibling supersedes it", async () => {
		const { h, a, id, opened, theirs } = await openedThenReplaced();
		// The phone's B is concurrent with A and won the display; A was moved aside, sealed.
		const shown = a.entries[0]!;
		const sealedA = {
			id,
			wrappedDek: "wd",
			dekIv: "di",
			iv: "iv",
			ciphertext: `ct:${JSON.stringify({ ...shown, id: undefined })}`,
			hlc: opened.hlc,
			vv: opened.vv,
		} as EncryptedEntry;
		const sideways: VaultEntries = {
			...a,
			entries: [{ ...shown, notes: "theirs" } as Entry],
			stamps: new Map([[id, theirs]]),
			causal: new Map([[id, { vv: { phone: theirs } }]]),
			conflicts: [sealedA],
		};
		const next = await h.mutations.update(
			sideways,
			id,
			loginWith("a", { password: "mine" }),
			opened,
		);
		expect(next.conflicts.map((e) => e.hlc)).toEqual([theirs]);
	});
});
