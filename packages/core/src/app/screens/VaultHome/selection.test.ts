import { describe, expect, it } from "vitest";
import {
	allSelected,
	hiddenSelectedCount,
	pruneSelection,
	selectAll,
	toggleSelected,
} from "./selection";

const items = (...ids: string[]) => ids.map((id) => ({ id }));
const sel = (...ids: string[]): ReadonlySet<string> => new Set(ids);

describe("toggleSelected", () => {
	it("adds an unselected id", () => {
		expect([...toggleSelected(sel("a"), "b")]).toEqual(["a", "b"]);
	});

	it("removes a selected id", () => {
		expect([...toggleSelected(sel("a", "b"), "a")]).toEqual(["b"]);
	});
});

describe("selectAll", () => {
	it("unions the visible ids into the selection", () => {
		expect([...selectAll(sel("x"), items("a", "b"))].sort()).toEqual(["a", "b", "x"]);
	});

	// Identity, not just equality: a fresh Set here would re-render the whole list.
	it("returns the same set when everything is already selected", () => {
		const before = sel("a", "b");
		expect(selectAll(before, items("a", "b"))).toBe(before);
	});
});

describe("allSelected", () => {
	it("is true only when every visible item is selected", () => {
		expect(allSelected(sel("a", "b"), items("a", "b"))).toBe(true);
		expect(allSelected(sel("a"), items("a", "b"))).toBe(false);
	});

	// Otherwise "Select all" on an empty search result renders as "Clear".
	it("is false for an empty list", () => {
		expect(allSelected(sel("a"), items())).toBe(false);
	});
});

describe("pruneSelection", () => {
	// A bulk delete removes the entries but the selection state outlives them; without
	// this the count in the toolbar keeps counting entries that no longer exist.
	it("drops ids that no longer exist", () => {
		expect([...pruneSelection(sel("a", "gone"), items("a", "b"))]).toEqual(["a"]);
	});

	it("returns the same set when every id survives", () => {
		const before = sel("a");
		expect(pruneSelection(before, items("a", "b"))).toBe(before);
	});

	it("returns the same set when nothing is selected", () => {
		const before = sel();
		expect(pruneSelection(before, items("a"))).toBe(before);
	});
});

describe("hiddenSelectedCount", () => {
	// Select 3, then narrow the search to 1: delete still acts on all 3, so the
	// toolbar has to say so.
	it("counts selected entries the filter is hiding", () => {
		expect(hiddenSelectedCount(sel("a", "b", "c"), items("a"))).toBe(2);
	});

	it("is zero when the whole selection is visible", () => {
		expect(hiddenSelectedCount(sel("a"), items("a", "b"))).toBe(0);
	});
});
