import { describe, expect, it } from "vitest";
import type { PendingAssociation } from "../adapters/shell";
import type { Entry, LoginEntry } from "../hooks/useVault";
import { planAssociationUpdates } from "./association";

const VAULT = "vault-a";

function login(id: string, urls: string[] = [], overrides: Partial<LoginEntry> = {}): LoginEntry {
	return {
		id,
		type: "login",
		name: `entry-${id}`,
		urls,
		username: "user@example.com",
		password: "pw",
		...overrides,
	} as LoginEntry;
}

function assoc(
	entryId: string,
	url: string,
	vaultId: string = VAULT,
	label?: string,
): PendingAssociation {
	return { entryId, url, vaultId, at: Date.now(), label };
}

describe("planAssociationUpdates", () => {
	it("appends the association url to the picked entry", () => {
		const entries: Entry[] = [login("e1", ["https://old.example"])];
		const out = planAssociationUpdates(entries, VAULT, [
			assoc("e1", "androidapp://com.example.app"),
		]);
		expect(out).toHaveLength(1);
		expect(out[0]!.entryId).toBe("e1");
		expect((out[0]!.data as LoginEntry).urls).toEqual([
			"https://old.example",
			"androidapp://com.example.app",
		]);
		expect(out[0]!.added).toEqual(["androidapp://com.example.app"]);
	});

	it("drops records from any other vault", () => {
		const entries: Entry[] = [login("e1")];
		expect(
			planAssociationUpdates(entries, "vault-b", [assoc("e1", "https://x.se", VAULT)]),
		).toHaveLength(0);
		expect(
			planAssociationUpdates(entries, undefined, [assoc("e1", "https://x.se", VAULT)]),
		).toHaveLength(0);
	});

	it("drops entries that were archived, deleted, or changed type since the pick", () => {
		const entries: Entry[] = [
			login("archived", [], { archivedAt: 123 }),
			{
				id: "card",
				type: "card",
				name: "c",
				cardholderName: "x",
				number: "1",
				expMonth: "1",
				expYear: "30",
			} as Entry,
		];
		const pending = [
			assoc("deleted", "https://x.se"),
			assoc("archived", "https://x.se"),
			assoc("card", "https://x.se"),
		];
		expect(planAssociationUpdates(entries, VAULT, pending)).toHaveLength(0);
	});

	it("never adds a target the entry already carries, whatever the spelling", () => {
		const entries: Entry[] = [
			login("e1", ["https://Instagram.com/", "androidapp://com.example.app", "github.com"]),
		];
		const pending = [
			assoc("e1", "https://instagram.com"),
			assoc("e1", "ANDROIDAPP://com.example.app"),
			assoc("e1", "https://github.com/login"),
		];
		expect(planAssociationUpdates(entries, VAULT, pending)).toHaveLength(0);
	});

	it("still adds genuinely new targets next to near-misses", () => {
		const entries: Entry[] = [login("e1", ["https://instagram.com"])];
		const out = planAssociationUpdates(entries, VAULT, [
			assoc("e1", "https://instagram.com"),
			assoc("e1", "https://login.instagram.com"),
		]);
		expect(out).toHaveLength(1);
		expect((out[0]!.data as LoginEntry).urls).toEqual([
			"https://instagram.com",
			"https://login.instagram.com",
		]);
	});

	it("collapses several associations on one entry into a single update", () => {
		const entries: Entry[] = [login("e1", ["https://old.example"])];
		const out = planAssociationUpdates(entries, VAULT, [
			assoc("e1", "androidapp://com.example.app"),
			assoc("e1", "https://example.com"),
			assoc("e1", "androidapp://com.example.app"),
		]);
		expect(out).toHaveLength(1);
		expect((out[0]!.data as LoginEntry).urls).toEqual([
			"https://old.example",
			"androidapp://com.example.app",
			"https://example.com",
		]);
		expect(out[0]!.added.join(", ")).toBe("androidapp://com.example.app, https://example.com");
	});

	it("plans one update per entry across a mixed batch", () => {
		const entries: Entry[] = [login("e1"), login("e2")];
		const out = planAssociationUpdates(entries, VAULT, [
			assoc("e1", "https://a.se"),
			assoc("e2", "androidapp://com.b"),
			assoc("e1", "https://a.se"),
		]);
		expect(out.map((u) => u.entryId).sort()).toEqual(["e1", "e2"]);
	});

	it("ignores empty urls and an empty batch", () => {
		const entries: Entry[] = [login("e1")];
		expect(planAssociationUpdates(entries, VAULT, [])).toHaveLength(0);
		expect(planAssociationUpdates(entries, VAULT, [assoc("e1", "")])).toHaveLength(0);
	});

	it("carries the friendly label the prompt showed, per added url", () => {
		const entries: Entry[] = [login("e1"), login("e2")];
		const out = planAssociationUpdates(entries, VAULT, [
			assoc("e1", "androidapp://com.example.app", VAULT, "Example"),
			assoc("e2", "https://a.se"),
		]);
		expect(out.map((u) => [u.entryId, u.label])).toEqual([
			["e1", "Example"],
			["e2", "https://a.se"],
		]);
	});
});
