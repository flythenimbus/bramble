import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entryDataSchema, normalizeEntryData } from "./entry-normalize";

describe("normalizeEntryData — legacy migrations", () => {
	it("defaults a typeless entry to login (pre-typed-entries vaults)", () => {
		const result = normalizeEntryData({
			name: "Old entry",
			username: "alice",
			password: "x",
			urls: ["https://example.com"],
		});
		expect(result.type).toBe("login");
	});

	it("collapses legacy `url: string` into `urls: [url]`", () => {
		const result = normalizeEntryData({
			type: "login",
			name: "Legacy single-url",
			username: "alice",
			password: "x",
			url: "https://example.com",
		});
		if (result.type !== "login") throw new Error("expected login");
		expect(result.urls).toEqual(["https://example.com"]);
		// The legacy field should be dropped so re-saves don't keep both
		// `url` and `urls` around.
		expect((result as unknown as Record<string, unknown>).url).toBeUndefined();
	});

	it("collapses empty legacy `url` into an empty `urls` array", () => {
		const result = normalizeEntryData({
			type: "login",
			name: "Legacy blank-url",
			username: "alice",
			password: "x",
			url: "",
		});
		if (result.type !== "login") throw new Error("expected login");
		expect(result.urls).toEqual([]);
	});

	it("collapses missing `url` (and no `urls`) into an empty `urls` array", () => {
		const result = normalizeEntryData({
			type: "login",
			name: "No url field at all",
			username: "alice",
			password: "x",
		});
		if (result.type !== "login") throw new Error("expected login");
		expect(result.urls).toEqual([]);
	});

	it("leaves modern multi-URL entries untouched", () => {
		const result = normalizeEntryData({
			type: "login",
			name: "Modern",
			username: "alice",
			password: "x",
			urls: ["https://example.com", "https://example.org"],
		});
		if (result.type !== "login") throw new Error("expected login");
		expect(result.urls).toEqual(["https://example.com", "https://example.org"]);
	});

	it("doesn't apply the url→urls migration to non-login types", () => {
		const result = normalizeEntryData({
			type: "card",
			name: "Visa",
			cardholderName: "Alice",
			number: "4111",
			expMonth: "12",
			expYear: "2030",
			cvv: "123",
			// A stray `url` on a card shouldn't get promoted into `urls`.
			url: "https://example.com",
		});
		expect(result.type).toBe("card");
		expect((result as unknown as Record<string, unknown>).urls).toBeUndefined();
	});
});

describe("normalizeEntryData — Zod tripwire", () => {
	let consoleError: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		consoleError.mockRestore();
	});

	it("returns the entry unchanged when the shape is valid", () => {
		normalizeEntryData({
			type: "login",
			name: "Valid",
			username: "alice",
			password: "x",
			urls: ["https://example.com"],
		});
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("logs a shape-only warning when the entry is malformed", () => {
		normalizeEntryData({
			type: "login",
			name: "Missing required password",
			username: "alice",
			urls: ["https://example.com"],
		});
		expect(consoleError).toHaveBeenCalledTimes(1);
		const msg = String(consoleError.mock.calls[0]?.[0] ?? "");
		expect(msg).toContain("unexpected shape");
		expect(msg).toContain("type=login");
		expect(msg).not.toContain("alice");
		expect(msg).not.toContain("Missing required password");
	});

	it("returns the candidate even when validation fails (forward-compat)", () => {
		// their data and a re-save under the current schema later
		// (re-)applies its rules.
		const result = normalizeEntryData({
			type: "login",
			name: "Future",
			username: "alice",
			password: "x",
			urls: ["https://example.com"],
			brandNewFieldFromVersion3: true,
		} as Record<string, unknown>);
		if (result.type !== "login") throw new Error("expected login");
		expect(result.username).toBe("alice");
		expect((result as unknown as Record<string, unknown>).brandNewFieldFromVersion3).toBe(true);
	});
});

describe("entryDataSchema (discriminated union)", () => {
	it("accepts each of the four entry types", () => {
		for (const candidate of [
			{
				type: "login",
				name: "x",
				username: "u",
				password: "p",
				urls: [],
			},
			{
				type: "card",
				name: "x",
				cardholderName: "Alice",
				number: "4111",
				expMonth: "12",
				expYear: "2030",
				cvv: "123",
			},
			{ type: "note", name: "x" },
			{ type: "ssh-key", name: "x", publicKey: "...", privateKey: "..." },
		]) {
			expect(entryDataSchema.safeParse(candidate).success).toBe(true);
		}
	});

	it("rejects an unknown discriminator", () => {
		const result = entryDataSchema.safeParse({ type: "wallet", name: "x" });
		expect(result.success).toBe(false);
	});
});
