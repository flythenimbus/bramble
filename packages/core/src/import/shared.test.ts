import { describe, expect, it } from "vitest";
import type { EntryData, LoginEntryData } from "../hooks/useVault";
import { parseCsvRows, summarize, toCustomFields } from "./shared";

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

// A URL with a port is one service among several on that host (#145), and only `exact` pins it.
describe("summarize: logins on a port", () => {
	const login = (urls: string[], over: Partial<LoginEntryData> = {}): LoginEntryData => ({
		type: "login",
		name: "NAS",
		urls,
		username: "admin",
		password: "pw",
		...over,
	});
	const modeOf = (...entries: EntryData[]) =>
		summarize(entries, 0, []).imported.map((e) => (e as LoginEntryData).subdomainMatch);

	it("matches a login exactly when its URL names a port", () => {
		expect(modeOf(login(["http://nas.local:5000"]), login(["https://10.0.0.2:8443/ui"]))).toEqual([
			"exact",
			"exact",
		]);
	});

	it("pins the whole login when any one of its URLs names a port", () => {
		expect(modeOf(login(["https://nas.local", "https://nas.local:9000"]))).toEqual(["exact"]);
	});

	it("reads a default port as no port", () => {
		expect(modeOf(login(["https://nas.local:443"]), login(["http://nas.local:80"]))).toEqual([
			undefined,
			undefined,
		]);
	});

	it("leaves a login with no port, or only an app link, on the default", () => {
		expect(
			modeOf(login(["https://github.com"]), login(["androidapp://com.example:5000"]), login([])),
		).toEqual([undefined, undefined, undefined]);
	});

	it("keeps a mode the source file chose", () => {
		expect(
			modeOf(
				login(["http://nas.local:5000"], { subdomainMatch: "subdomain" }),
				login(["http://nas.local:5000"], { subdomainMatch: "etld1" }),
			),
		).toEqual(["subdomain", "etld1"]);
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

describe("parseCsvRows", () => {
	it("splits plain rows and keeps values verbatim", () => {
		// Leading/trailing spaces in a password are real characters, not noise to trim.
		expect(parseCsvRows("a,b\n1, 2 ")).toEqual([
			["a", "b"],
			["1", " 2 "],
		]);
	});

	it("unwraps quotes and unescapes doubled quotes", () => {
		expect(parseCsvRows('"a","say ""hi""","c"')).toEqual([["a", 'say "hi"', "c"]]);
	});

	it("keeps commas and newlines inside quoted fields", () => {
		const rows = parseCsvRows('"one, two","line1\nline2",x');
		expect(rows).toEqual([["one, two", "line1\nline2", "x"]]);
	});

	it("accepts CRLF and strips a UTF-8 BOM", () => {
		expect(parseCsvRows("﻿a,b\r\n1,2\r\n")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
	});

	it("keeps a trailing empty field written as a bare comma", () => {
		// Apple writes an unset final column this way, so dropping it shifts every index.
		expect(parseCsvRows('"GitHub","https://gh.com","alice","pw","",')).toEqual([
			["GitHub", "https://gh.com", "alice", "pw", "", ""],
		]);
	});

	it("drops blank lines but not blank fields", () => {
		expect(parseCsvRows("a,b\n\n1,\n")).toEqual([
			["a", "b"],
			["1", ""],
		]);
	});

	it("returns the last row when the file has no trailing newline", () => {
		expect(parseCsvRows("a,b\n1,2")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
	});

	it("returns nothing for empty input", () => {
		expect(parseCsvRows("")).toEqual([]);
	});
});
