import { describe, expect, it } from "vitest";
import type { EntryData, LoginEntryData } from "../hooks/useVault";
import { compareHlc, HybridClock } from "../sync";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import {
	decodeVaultBlob,
	encodeVaultBlob,
	LEN_IV,
	LEN_SALT,
	LEN_SLOT_ID,
	LEN_VERIFIER,
	LEN_WRAP_IV,
	LEN_WRAPPED_VEK,
	type PasswordSlot,
	SLOT_KIND_PASSWORD,
} from "../vault-format";
import { createEntryMutations, type VaultEntries } from "./entry-mutations";

const te = new TextEncoder();
const td = new TextDecoder();

function fillBytes(length: number, base = 0): Uint8Array {
	const arr = new Uint8Array(length);
	for (let i = 0; i < length; i++) arr[i] = (base + i) & 0xff;
	return arr;
}

function passwordSlot(): PasswordSlot {
	return {
		kind: SLOT_KIND_PASSWORD,
		slotId: fillBytes(LEN_SLOT_ID, 0x10),
		salt: fillBytes(LEN_SALT, 0x20),
		verifier: fillBytes(LEN_VERIFIER, 0x30),
		wrapIv: fillBytes(LEN_WRAP_IV, 0x40),
		wrappedVek: fillBytes(LEN_WRAPPED_VEK, 0x50),
	};
}

function emptyVaultBytes(): Uint8Array {
	return encodeVaultBlob({
		slots: [passwordSlot()],
		entriesIv: fillBytes(LEN_IV, 0x70),
		entriesCiphertext: new Uint8Array(0),
	});
}

const empty = (): VaultEntries => ({ entries: [], stamps: new Map(), tombstones: new Map() });
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

// Wires the module to a fake crypto/storage/autofill plus an in-memory "disk"
// that round-trips through the real encode/decode, so the persist primitive is
// exercised end to end. The clock is a real HybridClock with a frozen wall time,
// so stamps differ only by their monotonic counter.
function harness(now: () => number = () => 1000) {
	let disk = emptyVaultBytes();
	let writes = 0;
	const indexCalls: unknown[][] = [];
	const crypto = {
		encryptEntry: async (json: string) => ({
			ciphertext: `ct:${json}`,
			iv: "iv",
			wrappedDek: "wd",
			dekIv: "di",
		}),
		encryptWithVek: async (plaintext: string) => ({
			iv: bytesToBase64(fillBytes(LEN_IV)),
			ciphertext: bytesToBase64(te.encode(plaintext)),
		}),
		decryptWithVek: async (_iv: string, ciphertext: string) => td.decode(base64ToBytes(ciphertext)),
	};
	const storage = {
		writeVaultBlob: async (bytes: Uint8Array) => {
			disk = bytes;
			writes++;
		},
	};
	const autofill = {
		setIndex: async (entries: { type: string }[]) => {
			indexCalls.push(entries);
		},
	};
	const readDecodedBlob = async () => ({ blob: decodeVaultBlob(disk) });
	const c = new HybridClock("device-a", now);
	const mutations = createEntryMutations({
		crypto,
		storage,
		autofill,
		readDecodedBlob,
		clock: async () => c,
	});
	return { mutations, writes: () => writes, indexCalls };
}

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
		expect(JSON.stringify(payload)).not.toContain("archivedAt");
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
