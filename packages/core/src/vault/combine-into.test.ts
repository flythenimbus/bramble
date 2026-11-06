import { describe, expect, it } from "vitest";
import type { Entry, EntryData } from "../hooks/useVault";
import type { FileRecord } from "../sync/entries-payload";
import { collectCarry, placeCarry } from "./combine-into";

const login = (id: string, site: string, username = "u", password = "p"): Entry =>
	({
		id,
		type: "login",
		name: site,
		username,
		password,
		urls: [`https://${site}`],
	}) as unknown as Entry;

const file = (id: string, entryId?: string): FileRecord =>
	({ id, entryId, hash: id.padEnd(64, "0") }) as unknown as FileRecord;

const stager = (fail = new Set<string>()) => ({
	stage: async (record: FileRecord) => {
		if (fail.has(record.id)) throw new Error("not on this device");
		return {
			source: { kind: "bytes" as const, bytes: new Uint8Array([1]) },
			name: `${record.id}.txt`,
			mime: "text/plain",
			size: 1,
		};
	},
});

describe("collectCarry", () => {
	it("carries every entry without its id, and every attachment on them", async () => {
		const carry = await collectCarry([login("a", "a.com")], [file("f1", "a")], stager());
		expect(carry.items).toHaveLength(1);
		expect("id" in (carry.items[0] as object)).toBe(false);
		expect(carry.files).toHaveLength(1);
		expect(carry.files[0]?.entry).toBe(carry.items[0]);
		expect(carry.uncarried).toBe(0);
	});

	it("counts a file it cannot read, so the copy can never claim success", async () => {
		const carry = await collectCarry(
			[login("a", "a.com")],
			[file("f1", "a")],
			stager(new Set(["f1"])),
		);
		expect(carry.files).toHaveLength(0);
		expect(carry.uncarried).toBe(1);
	});

	it("counts a file that belongs to no entry, which has nowhere to go", async () => {
		const carry = await collectCarry([login("a", "a.com")], [file("loose")], stager());
		expect(carry.uncarried).toBe(1);
	});

	it("counts every file when this platform cannot read them back", async () => {
		const carry = await collectCarry([login("a", "a.com")], [file("f1", "a")], null);
		expect(carry.uncarried).toBe(1);
	});
});

describe("placeCarry", () => {
	it("holds back a login identical but for its old passwords, rather than drop them", async () => {
		// An exact duplicate is dropped, so old passwords must make it something else: held back, it
		// keeps the old vault, and the user can copy it anyway.
		const history = [{ value: "older", changedAt: 1 }];
		const carry = await collectCarry(
			[{ ...login("a", "same.com"), passwordChangelog: history } as unknown as Entry],
			[],
			stager(),
		);
		const placed = placeCarry([login("x", "same.com")], carry);
		expect(placed.items).toEqual([]);
		expect(placed.heldBack.items).toHaveLength(1);
	});

	it("imports new entries with their files, puts a duplicate's files on the existing entry, and holds look-alikes back", async () => {
		const existing = [login("x", "same.com"), login("y", "alike.com", "u", "p")];
		const carry = await collectCarry(
			[login("a", "same.com"), login("b", "alike.com", "U", "p"), login("c", "new.com")],
			[file("fa", "a"), file("fb", "b"), file("fc", "c")],
			stager(),
		);
		// "same.com" is identical to x; "alike.com" differs only in case of the username.
		const placed = placeCarry(existing, carry);

		expect(placed.items.map((e) => (e as EntryData & { name: string }).name)).toEqual(["new.com"]);
		expect(placed.attachments.map((a) => a.onto)).toEqual(
			expect.arrayContaining([{ entryId: "x" }, { item: placed.items[0] }]),
		);
		expect(placed.heldBack.items.map((e) => (e as EntryData & { name: string }).name)).toEqual([
			"alike.com",
		]);
		expect(placed.heldBack.attachments).toHaveLength(1);
	});
});
