import { describe, expect, it } from "vitest";
import {
	DEFAULT_SEARCH,
	filterAndSortEntries,
	queryTokens,
	type SearchableEntry,
	type VaultSearch,
	vaultSearchSchema,
} from "./vault-search";

function item(over: Partial<SearchableEntry> & { name: string }): SearchableEntry {
	return {
		id: over.name,
		type: "login",
		searchText: over.name.toLowerCase(),
		...over,
	};
}

const search = (over: Partial<VaultSearch> = {}): VaultSearch => ({ ...DEFAULT_SEARCH, ...over });

describe("filterAndSortEntries", () => {
	it("requires every token to match, order-independent (fixes the two-word bug)", () => {
		const items = [
			item({ name: "GitHub", searchText: "github alice github.com" }),
			item({ name: "GitLab", searchText: "gitlab bob gitlab.com" }),
		];
		// "alice github" is non-contiguous in the haystack; token AND still matches.
		expect(filterAndSortEntries(items, search({ q: "alice github" })).map((i) => i.name)).toEqual([
			"GitHub",
		]);
	});

	it("matches case-insensitively", () => {
		const items = [item({ name: "Bank", searchText: "bank teller@bank.com" })];
		expect(filterAndSortEntries(items, search({ q: "TELLER" }))).toHaveLength(1);
	});

	it("hides archived entries from the live list, however well they match", () => {
		const items = [
			item({ name: "Old bank", archived: true, searchText: "old bank" }),
			item({ name: "New bank", searchText: "new bank" }),
		];
		expect(filterAndSortEntries(items, search({ q: "bank" })).map((i) => i.name)).toEqual([
			"New bank",
		]);
	});

	it("shows only archived entries in the archive view", () => {
		const items = [
			item({ name: "Old bank", archived: true, searchText: "old bank" }),
			item({ name: "New bank", searchText: "new bank" }),
		];
		expect(filterAndSortEntries(items, search({ archived: true })).map((i) => i.name)).toEqual([
			"Old bank",
		]);
	});

	// The two sides are disjoint, so type and text still narrow within the archive.
	it("still applies type and text filters inside the archive view", () => {
		const items = [
			item({ name: "Old card", type: "card", archived: true, searchText: "old card" }),
			item({ name: "Old login", archived: true, searchText: "old login" }),
		];
		expect(
			filterAndSortEntries(items, search({ archived: true, type: "card" })).map((i) => i.name),
		).toEqual(["Old card"]);
	});

	it("filters by type before matching text", () => {
		const items = [
			item({ name: "Visa", type: "card", searchText: "visa" }),
			item({ name: "Vault note", type: "note", searchText: "vault note" }),
		];
		expect(filterAndSortEntries(items, search({ type: "card" })).map((i) => i.name)).toEqual([
			"Visa",
		]);
	});

	it("sorts by name ascending and descending", () => {
		const items = [item({ name: "Charlie" }), item({ name: "alpha" }), item({ name: "Bravo" })];
		expect(filterAndSortEntries(items, search({ sort: "name-asc" })).map((i) => i.name)).toEqual([
			"alpha",
			"Bravo",
			"Charlie",
		]);
		expect(filterAndSortEntries(items, search({ sort: "name-desc" })).map((i) => i.name)).toEqual([
			"Charlie",
			"Bravo",
			"alpha",
		]);
	});

	it("sorts by recency with missing timestamps last, name as tiebreak", () => {
		const items = [
			item({ name: "Old", lastUsedAt: 100 }),
			item({ name: "Never" }),
			item({ name: "Fresh", lastUsedAt: 900 }),
			item({ name: "AlsoNever" }),
		];
		expect(filterAndSortEntries(items, search({ sort: "recent-used" })).map((i) => i.name)).toEqual(
			["Fresh", "Old", "AlsoNever", "Never"],
		);
	});

	it("does not mutate the input array", () => {
		const items = [item({ name: "B" }), item({ name: "A" })];
		const before = items.map((i) => i.name);
		filterAndSortEntries(items, search({ sort: "name-asc" }));
		expect(items.map((i) => i.name)).toEqual(before);
	});

	it("floats current-site matches to the top, sorted within each group", () => {
		const items = [
			item({ name: "Zeta" }),
			item({ name: "Alpha" }),
			item({ name: "GitHub" }),
			item({ name: "Beta" }),
		];
		const matched = new Set(["GitHub", "Zeta"]);
		expect(
			filterAndSortEntries(items, search({ sort: "name-asc" }), matched).map((i) => i.name),
		).toEqual(["GitHub", "Zeta", "Alpha", "Beta"]);
	});

	it("boosts matches within an active search query", () => {
		const items = [
			item({ name: "GitHub", searchText: "github octocat" }),
			item({ name: "GitLab", searchText: "gitlab" }),
			item({ name: "Gitea", searchText: "gitea" }),
		];
		const matched = new Set(["Gitea"]);
		expect(
			filterAndSortEntries(items, search({ q: "git", sort: "name-asc" }), matched).map(
				(i) => i.name,
			),
		).toEqual(["Gitea", "GitHub", "GitLab"]);
	});

	it("ignores an empty matchedIds set", () => {
		const items = [item({ name: "B" }), item({ name: "A" })];
		expect(
			filterAndSortEntries(items, search({ sort: "name-asc" }), new Set()).map((i) => i.name),
		).toEqual(["A", "B"]);
	});
});

describe("vaultSearchSchema", () => {
	it("keeps valid params", () => {
		expect(
			vaultSearchSchema.parse({ q: "hi", type: "card", sort: "recent-used", archived: true }),
		).toEqual({
			q: "hi",
			type: "card",
			sort: "recent-used",
			archived: true,
		});
	});

	it("drops unknown values to undefined instead of throwing", () => {
		expect(vaultSearchSchema.parse({ type: "folder", sort: "date", archived: "yes" })).toEqual({
			type: undefined,
			sort: undefined,
			archived: undefined,
		});
	});

	it("omits absent params so the route can fall back to defaults", () => {
		expect(vaultSearchSchema.parse({})).toEqual({});
	});
});

describe("tokenizer", () => {
	it("tokenizes on whitespace and lowercases", () => {
		expect(queryTokens("  Alice   GitHub ")).toEqual(["alice", "github"]);
		expect(queryTokens("")).toEqual([]);
	});
});
