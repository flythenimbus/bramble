import { describe, expect, it } from "vitest";
import type { Entry } from "../hooks/useVault";
import {
	allTags,
	importTag,
	MAX_TAGS_PER_ENTRY,
	normalizeTags,
	tagKey,
	tagsEqual,
	withImportTag,
} from "./tags";

const entry = (id: string, tags?: string[]): Entry =>
	({ id, type: "login", name: id, urls: [], username: "u", password: "p", tags }) as Entry;

describe("normalizeTags", () => {
	it("trims and drops empties", () => {
		expect(normalizeTags(["  work  ", "", "   "])).toEqual(["work"]);
	});

	it("returns undefined rather than an empty array", () => {
		expect(normalizeTags([])).toBeUndefined();
		expect(normalizeTags(["  "])).toBeUndefined();
		expect(normalizeTags(undefined)).toBeUndefined();
	});

	// `#` is the search syntax, not part of the name; storing it would make the tag
	// reachable only as `##work`.
	it("strips a leading hash", () => {
		expect(normalizeTags(["#work", "##bank"])).toEqual(["work", "bank"]);
	});

	// The search box is whitespace-delimited, so a tag with a space in it could never be
	// typed as a `#` token.
	it("hyphenates inner whitespace so every tag is reachable by #syntax", () => {
		expect(normalizeTags(["shared household", "a  b\tc"])).toEqual(["shared-household", "a-b-c"]);
	});

	it("dedupes case-insensitively, keeping the first spelling typed", () => {
		expect(normalizeTags(["Work", "work", "WORK"])).toEqual(["Work"]);
	});

	it("ignores non-strings from a foreign import", () => {
		expect(normalizeTags([1, null, "work", { a: 1 }])).toEqual(["work"]);
		expect(normalizeTags("work")).toBeUndefined();
	});

	it("caps the count", () => {
		const many = Array.from({ length: MAX_TAGS_PER_ENTRY + 10 }, (_, i) => `t${i}`);
		expect(normalizeTags(many)).toHaveLength(MAX_TAGS_PER_ENTRY);
	});

	it("caps the length of one tag", () => {
		expect(normalizeTags(["x".repeat(200)])?.[0]).toHaveLength(64);
	});
});

describe("tagKey", () => {
	it("folds case so Work and work are one tag", () => {
		expect(tagKey("Work")).toBe(tagKey(" work "));
	});
});

describe("tagsEqual", () => {
	it("compares element-wise", () => {
		expect(tagsEqual(["a", "b"], ["a", "b"])).toBe(true);
		expect(tagsEqual(["a", "b"], ["b", "a"])).toBe(false);
		expect(tagsEqual(undefined, undefined)).toBe(true);
		expect(tagsEqual(undefined, [])).toBe(false);
	});
});

describe("allTags", () => {
	it("collects distinct tags across entries, sorted", () => {
		expect(allTags([entry("a", ["work", "bank"]), entry("b", ["work"]), entry("c")])).toEqual([
			"bank",
			"work",
		]);
	});

	// Two spellings of one tag behave identically in search, so offering both as
	// suggestions would be offering the same filter twice.
	it("offers one suggestion per key, not one per spelling", () => {
		expect(allTags([entry("a", ["Work"]), entry("b", ["work"])])).toEqual(["Work"]);
	});

	it("is empty for a vault with no tags", () => {
		expect(allTags([entry("a"), entry("b")])).toEqual([]);
	});
});

describe("import tag (#209)", () => {
	const day = new Date(2026, 10, 9, 23, 30);

	it("names the local day and time of the import", () => {
		expect(importTag(day)).toBe("imported-2026-11-09-2330");
		expect(importTag(new Date(2026, 0, 2, 3, 4))).toBe("imported-2026-01-02-0304");
	});

	// Two imports on one day get their own tags, and `#imported-2026-11-09` still finds both:
	// the tag filter matches the start of a tag.
	it("tells two imports on one day apart, under one day prefix", () => {
		const later = importTag(new Date(2026, 10, 9, 23, 45));
		expect(later).not.toBe(importTag(day));
		expect(later.startsWith("imported-2026-11-09")).toBe(true);
	});

	it("adds it after an entry's own tags", () => {
		const [a, b] = withImportTag([entry("a", ["work"]), entry("b")], day);
		expect(a?.tags).toEqual(["work", "imported-2026-11-09-2330"]);
		expect(b?.tags).toEqual(["imported-2026-11-09-2330"]);
	});

	it("never pushes out a tag the entry already had", () => {
		const full = Array.from({ length: MAX_TAGS_PER_ENTRY }, (_, i) => `t${i}`);
		expect(withImportTag([entry("a", full)], day)[0]?.tags).toEqual(full);
	});
});
