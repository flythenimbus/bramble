import { describe, expect, it } from "vitest";
import type { EntryData } from "../hooks/useVault";
import { summarize, toCustomFields } from "./shared";

describe("summarize", () => {
	it("validates output against the EntryData schema and drops malformed entries", () => {
		const good: EntryData = { type: "note", name: "ok" };
		// Simulate a parser bug: a login missing its required password/username.
		const bad = { type: "login", name: "broken", url: "" } as unknown as EntryData;

		const res = summarize([good, bad], 0, []);

		expect(res.imported).toEqual([good]);
		expect(res.byType).toEqual({ note: 1 });
		expect(res.skipped).toBe(1);
		expect(res.warnings).toHaveLength(1);
	});

	it("rejects an entry with an unknown type", () => {
		const bad = { type: "wormhole", name: "x" } as unknown as EntryData;
		const res = summarize([bad], 0, []);
		expect(res.imported).toHaveLength(0);
		expect(res.skipped).toBe(1);
	});
});

describe("toCustomFields", () => {
	it("drops blanks and preserves the hidden flag", () => {
		expect(
			toCustomFields([
				{ key: "a", value: "1" },
				{ key: "", value: "x" }, // blank key
				{ key: "b", value: "" }, // blank value
				{ key: "c", value: "3", hidden: true },
			]),
		).toEqual([
			{ key: "a", value: "1" },
			{ key: "c", value: "3", hidden: true },
		]);
	});

	it("returns undefined when nothing remains", () => {
		expect(toCustomFields([{ key: "", value: "" }])).toBeUndefined();
	});
});
