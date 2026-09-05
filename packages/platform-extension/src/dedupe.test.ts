import type { IndexEntry, LoginIndexEntry } from "@core/adapters/autofill";
import { describe, expect, it } from "vitest";
import { dedupeCapture, hostnameMatches, registrableDomain } from "./dedupe";

function login(over: Partial<LoginIndexEntry> & Pick<LoginIndexEntry, "id">): LoginIndexEntry {
	return {
		type: "login",
		hostnames: [],
		name: "Test",
		username: "alice",
		password: "hunter2",
		...over,
	};
}

function indexOf(...entries: IndexEntry[]): Map<string, IndexEntry> {
	return new Map(entries.map((e) => [e.id, e]));
}

describe("registrableDomain", () => {
	it("collapses subdomains to eTLD+1", () => {
		expect(registrableDomain("mail.google.com")).toBe("google.com");
		expect(registrableDomain("accounts.google.com")).toBe("google.com");
	});

	it("handles bare apex domains", () => {
		expect(registrableDomain("example.com")).toBe("example.com");
	});

	it("falls back to the raw input for unparseable hostnames", () => {
		// etld1 returns null for IP literals / IDN edge cases: degrade to exact match.
		expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
		expect(registrableDomain("localhost")).toBe("localhost");
	});

	it("handles two-level public suffixes without the PSL table", () => {
		expect(registrableDomain("mail.example.co.uk")).toBe("example.co.uk");
		expect(registrableDomain("example.co.uk")).toBe("example.co.uk");
	});
});

describe("hostnameMatches", () => {
	it("matches sibling subdomains under default eTLD+1 policy", () => {
		const entry = login({ id: "1", hostnames: ["accounts.google.com"] });
		expect(hostnameMatches(entry, "mail.google.com")).toBe(true);
		expect(hostnameMatches(entry, "google.com")).toBe(true);
	});

	it("doesn't cross eTLD+1 boundaries", () => {
		const entry = login({ id: "1", hostnames: ["example.com"] });
		expect(hostnameMatches(entry, "example.org")).toBe(false);
		expect(hostnameMatches(entry, "evil-example.com")).toBe(false);
	});

	it("respects the 'exact' policy", () => {
		const entry = login({
			id: "1",
			hostnames: ["mail.google.com"],
			subdomainMatch: "exact",
		});
		expect(hostnameMatches(entry, "mail.google.com")).toBe(true);
		expect(hostnameMatches(entry, "accounts.google.com")).toBe(false);
		expect(hostnameMatches(entry, "google.com")).toBe(false);
	});

	it("respects the 'subdomain' policy", () => {
		const entry = login({
			id: "1",
			hostnames: ["example.com"],
			subdomainMatch: "subdomain",
		});
		expect(hostnameMatches(entry, "example.com")).toBe(true);
		expect(hostnameMatches(entry, "m.example.com")).toBe(true);
		expect(hostnameMatches(entry, "deep.sub.example.com")).toBe(true);
		// "subdomain" must not match a domain that merely ends with the host string.
		expect(hostnameMatches(entry, "notexample.com")).toBe(false);
	});

	it("matches against any of the entry's hostnames", () => {
		const entry = login({
			id: "1",
			hostnames: ["sso.acme.com", "products.acme.io"],
		});
		expect(hostnameMatches(entry, "sso.acme.com")).toBe(true);
		expect(hostnameMatches(entry, "products.acme.io")).toBe(true);
		expect(hostnameMatches(entry, "elsewhere.example.com")).toBe(false);
	});

	it("is case-insensitive", () => {
		const entry = login({ id: "1", hostnames: ["Example.com"] });
		expect(hostnameMatches(entry, "EXAMPLE.com")).toBe(true);
	});

	it("returns false when the entry has no hostnames", () => {
		// Empty hostnames (legacy/imported entries) must not match every site.
		const entry = login({ id: "1", hostnames: [] });
		expect(hostnameMatches(entry, "example.com")).toBe(false);
	});
});

describe("dedupeCapture", () => {
	it("returns save when the index is null (locked vault)", () => {
		const result = dedupeCapture(null, "example.com", "alice", "hunter2");
		expect(result.kind).toBe("save");
	});

	it("returns save when there are no hostname matches", () => {
		const index = indexOf(login({ id: "1", hostnames: ["other.com"], username: "alice" }));
		const result = dedupeCapture(index, "example.com", "alice", "hunter2");
		expect(result.kind).toBe("save");
	});

	it("returns exact when the same {username, password} is already stored", () => {
		const index = indexOf(
			login({
				id: "1",
				hostnames: ["example.com"],
				username: "alice",
				password: "hunter2",
			}),
		);
		const result = dedupeCapture(index, "example.com", "alice", "hunter2");
		expect(result.kind).toBe("exact");
	});

	it("returns update when the username matches but the password differs", () => {
		const index = indexOf(
			login({
				id: "1",
				hostnames: ["example.com"],
				username: "alice",
				password: "old",
			}),
		);
		const result = dedupeCapture(index, "example.com", "alice", "new");
		expect(result.kind).toBe("update");
		if (result.kind !== "update") throw new Error("unreachable");
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]!.id).toBe("1");
	});

	it("returns update when the password matches but the username differs", () => {
		// Same password, changed username counts as an update, not a new save.
		const index = indexOf(
			login({
				id: "1",
				hostnames: ["example.com"],
				username: "old@example.com",
				password: "shared",
			}),
		);
		const result = dedupeCapture(index, "example.com", "new@example.com", "shared");
		expect(result.kind).toBe("update");
	});

	it("returns update with multiple candidates when several entries match", () => {
		const index = indexOf(
			login({
				id: "personal",
				hostnames: ["example.com"],
				username: "alice@personal.com",
				password: "a",
			}),
			login({
				id: "work",
				hostnames: ["example.com"],
				username: "alice@work.com",
				password: "b",
			}),
		);
		const result = dedupeCapture(index, "example.com", "alice@personal.com", "c");
		expect(result.kind).toBe("update");
		if (result.kind !== "update") throw new Error("unreachable");
		expect(result.candidates).toHaveLength(2);
		// Same-username candidate floats to the top.
		expect(result.candidates[0]!.id).toBe("personal");
		expect(result.candidates[1]!.id).toBe("work");
	});

	it("ignores card entries when matching", () => {
		const cardEntry: IndexEntry = {
			type: "card",
			id: "card",
			name: "Visa",
			cardholderName: "Alice",
			number: "4111111111111111",
			expMonth: "12",
			expYear: "2030",
			cvv: "123",
		};
		const result = dedupeCapture(indexOf(cardEntry), "example.com", "alice", "hunter2");
		expect(result.kind).toBe("save");
	});

	it("respects per-entry subdomainMatch when filtering candidates", () => {
		// "exact" entry must not surface as a candidate on a sibling subdomain.
		const index = indexOf(
			login({
				id: "1",
				hostnames: ["mail.google.com"],
				subdomainMatch: "exact",
				username: "alice",
				password: "x",
			}),
		);
		const result = dedupeCapture(index, "accounts.google.com", "alice", "x");
		expect(result.kind).toBe("save");
	});
});
