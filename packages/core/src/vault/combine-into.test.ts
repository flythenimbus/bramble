import { describe, expect, it } from "vitest";
import { type BackupTargetConfig, keyVaultIdFor, targetPrefixFor } from "../backup/config";
import type { Entry, EntryData } from "../hooks/useVault";
import type { FileRecord } from "../sync/entries-payload";
import {
	collectCarry,
	foldCarriedCopy,
	placeCarry,
	readCarriedTargets,
	sealCarriedTargets,
} from "./combine-into";

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

	it("sends a dropped copy's files where the copy it matched went, even when that was held back", async () => {
		const existing = [login("y", "alike.com", "u", "p")];
		const carry = await collectCarry(
			[login("a", "alike.com", "U", "p"), login("b", "alike.com", "U", "p")],
			[file("fb", "b")],
			stager(),
		);
		const placed = placeCarry(existing, carry);
		expect(placed.attachments).toEqual([]);
		expect(placed.heldBack.attachments.map((a) => a.onto)).toEqual([
			{ item: placed.heldBack.items[0] },
		]);
	});

	describe("a copy of an entry the desktop's vault holds", () => {
		const carried = (over: Record<string, unknown>) =>
			collectCarry([{ ...login("a", "same.com"), ...over } as unknown as Entry], [], stager());

		it("reports what it brings, and nothing is left behind", async () => {
			const carry = await carried({ tags: ["work"] });
			const placed = placeCarry([login("x", "same.com")], carry);
			expect(placed.items).toEqual([]);
			expect(placed.heldBack.items).toEqual([]);
			expect(placed.matched).toEqual([{ id: "x", copy: carry.items[0] }]);
			expect(placed.tagsLeftOver).toBe(0);
		});

		it("matches a login identical but for its old passwords, whose history comes across", async () => {
			const carry = await carried({ passwordChangelog: [{ value: "older", changedAt: 1 }] });
			const placed = placeCarry([login("x", "same.com")], carry);
			expect(placed.heldBack.items).toEqual([]);
			expect(placed.matched).toEqual([{ id: "x", copy: carry.items[0] }]);
		});

		it("reports nothing when it brings nothing, so no write is made for it", async () => {
			const carry = await carried({ tags: ["work"] });
			const existing = { ...login("x", "same.com"), tags: ["Work"] } as unknown as Entry;
			expect(placeCarry([existing], carry).matched).toEqual([]);
		});

		it("counts tags that will not fit on the entry, so the old vault stays with them", async () => {
			const tags = Array.from({ length: 32 }, (_, i) => `d${i}`);
			const carry = await carried({ tags: ["extra"] });
			const existing = { ...login("x", "same.com"), tags } as unknown as Entry;
			expect(placeCarry([existing], carry).tagsLeftOver).toBe(1);
		});

		it("folds two copies inside the carry together, keeping the one object the files point at", async () => {
			const carry = await collectCarry(
				[
					{ ...login("a", "new.com"), tags: ["one"] } as unknown as Entry,
					{ ...login("b", "new.com"), tags: ["two"] } as unknown as Entry,
				],
				[file("fa", "a"), file("fb", "b")],
				stager(),
			);
			const placed = placeCarry([], carry);
			expect(placed.items).toHaveLength(1);
			expect(placed.items[0]?.tags).toEqual(["one", "two"]);
			expect(placed.attachments.map((a) => a.onto)).toEqual([
				{ item: placed.items[0] },
				{ item: placed.items[0] },
			]);
		});
	});
});

describe("foldCarriedCopy", () => {
	const entry = (over: Record<string, unknown> = {}) =>
		({ ...login("x", "same.com"), ...over }) as unknown as Entry;
	const copy = (over: Record<string, unknown> = {}) => {
		const { id: _id, ...data } = entry(over);
		return data as EntryData;
	};

	it("adds the copy's tags after the entry's own, keeping the entry's spelling", () => {
		const next = foldCarriedCopy(entry({ tags: ["Work"] }), copy({ tags: ["work", "home"] }));
		expect(next.tags).toEqual(["Work", "home"]);
	});

	it("returns the entry itself when the copy adds nothing", () => {
		const e = entry({ tags: ["work"], passwordChangelog: [{ value: "old", changedAt: 2 }] });
		expect(foldCarriedCopy(e, copy({ tags: ["WORK"] }))).toBe(e);
		expect(foldCarriedCopy(e, copy({ passwordChangelog: [{ value: "old", changedAt: 1 }] }))).toBe(
			e,
		);
	});

	it("brings an archived entry back when the copy is in use", () => {
		const next = foldCarriedCopy(entry({ archivedAt: 5 }), copy());
		expect("archivedAt" in next).toBe(false);
	});

	it("leaves an entry in use alone when the copy is archived", () => {
		const e = entry();
		expect(foldCarriedCopy(e, copy({ archivedAt: 5 }))).toBe(e);
	});

	it("keeps an entry archived when both are", () => {
		const e = entry({ archivedAt: 5 });
		expect(foldCarriedCopy(e, copy({ archivedAt: 9 }))).toBe(e);
	});

	it("joins old passwords newest first, without the one in use", () => {
		const next = foldCarriedCopy(
			entry({ passwordChangelog: [{ value: "b", changedAt: 2 }] }),
			copy({
				passwordChangelog: [
					{ value: "c", changedAt: 3 },
					{ value: "p", changedAt: 9 },
					{ value: "a", changedAt: 1 },
				],
			}),
		) as Entry & { passwordChangelog: { value: string }[] };
		expect(next.passwordChangelog.map((r) => r.value)).toEqual(["c", "b", "a"]);
	});

	it("leaves a full log alone when all the copy holds is older", () => {
		const rows = [5, 4, 3, 2, 1].map((n) => ({ value: `v${n}`, changedAt: n + 10 }));
		const e = entry({ passwordChangelog: rows });
		expect(
			foldCarriedCopy(e, copy({ passwordChangelog: [{ value: "older", changedAt: 1 }] })),
		).toBe(e);
	});

	it("ignores a copy's history on an entry that is not a login", () => {
		const e = { id: "n", type: "note", name: "n" } as unknown as Entry;
		expect(foldCarriedCopy(e, { type: "note", name: "n" } as EntryData)).toBe(e);
	});
});

describe("carrying backup targets", () => {
	const target = (id: string, creds: unknown, extra: Record<string, unknown> = {}) =>
		({
			id,
			providerId: "nextcloud",
			provider: "webdav",
			serverUrl: "https://dav.example/",
			path: "/backups",
			frequency: "daily",
			keep: 7,
			creds,
			...extra,
		}) as unknown as BackupTargetConfig;
	/** A key that can only open what it sealed, as a vault's key can. */
	const keyed = (name: string) => ({
		decryptWithVek: async (iv: string, ciphertext: string) => {
			if (iv !== name) throw new Error("wrong key");
			return ciphertext;
		},
		encryptWithVek: async (plaintext: string) => ({ iv: name, ciphertext: plaintext }),
	});

	it("opens each target with the old key and seals it with the new one", async () => {
		const { targets: carried } = await readCarriedTargets(
			[target("t1", { iv: "old", ciphertext: '{"password":"s3"}' })],
			keyed("old"),
		);
		const sealed = await sealCarriedTargets(carried, keyed("new"));
		expect(sealed).toHaveLength(1);
		expect(sealed[0]?.creds).toEqual({ iv: "new", ciphertext: '{"password":"s3"}' });
		expect(sealed[0]?.serverUrl).toBe("https://dav.example/");
		expect(sealed[0]?.keep).toBe(7);
	});

	it("leaves the old vault's backup history behind, so the first backup here is not skipped", async () => {
		const { targets: carried } = await readCarriedTargets(
			[
				target(
					"t1",
					{ iv: "old", ciphertext: "{}" },
					{
						lastBackupAt: 5,
						lastVaultHash: "abc",
						lastError: "nope",
						waiting: "files",
						failures: 3,
						failedAt: 6,
						sharedFolder: true,
					},
				),
			],
			keyed("old"),
		);
		const [sealed] = await sealCarriedTargets(carried, keyed("new"));
		for (const key of [
			"lastBackupAt",
			"lastVaultHash",
			"lastError",
			"waiting",
			"failures",
			"failedAt",
			"sharedFolder",
		]) {
			expect(sealed).not.toHaveProperty(key);
		}
	});

	it("stamps its snapshots with the new vault, so pruning can't reach the old vault's", async () => {
		const { targets: carried } = await readCarriedTargets(
			[target("t1", { iv: "old", ciphertext: "{}" }, { sharedFolder: true })],
			keyed("old"),
		);
		const [sealed] = await sealCarriedTargets(carried, keyed("new"));
		expect(keyVaultIdFor(sealed as BackupTargetConfig, "new-vault")).toBe("new-vault");
		expect(targetPrefixFor(sealed as BackupTargetConfig, "new-vault", true)).toBe("backups");
	});

	it("counts a target whose credentials won't open, rather than dropping it quietly", async () => {
		const read = await readCarriedTargets(
			[
				target("dead", { iv: "another-vault", ciphertext: "{}" }),
				target("live", { iv: "old", ciphertext: "{}" }),
			],
			keyed("old"),
		);
		expect(read.targets.map((c) => c.target.id)).toEqual(["live"]);
		expect(read.unreadable).toBe(1);
	});

	it("counts a target the operating system holds the credentials for", async () => {
		const read = await readCarriedTargets([target("os", { wrap: "os" })], keyed("old"));
		expect(read).toEqual({ targets: [], unreadable: 1 });
	});

	it("reads nothing from no list at all", async () => {
		expect(await readCarriedTargets(undefined, keyed("old"))).toEqual({
			targets: [],
			unreadable: 0,
		});
		expect(await readCarriedTargets([], keyed("old"))).toEqual({ targets: [], unreadable: 0 });
	});
});
