import { describe, expect, it, vi } from "vitest";
import { createCatchAllClient, looksLikeDomain } from "./catchall";
import { AliasError } from "./types";

// The provider with no provider: the user points a domain they own at their inbox, and Bramble
// makes the address locally. See docs/email-aliases.md.

const client = (over = {}) => createCatchAllClient({ domain: "example.com", ...over });

describe("looksLikeDomain", () => {
	it.each(["example.com", "mail.example.co.uk", "my-domain.io", "a.bc"])("accepts %s", (d) => {
		expect(looksLikeDomain(d)).toBe(true);
	});

	// Shallow on purpose. It catches the slips a person actually makes typing into this box; it
	// cannot tell whether the catch-all works, which is why the UI asks them to check.
	it.each([
		["", "empty"],
		["me@example.com", "a whole address pasted in"],
		["example", "no dot"],
		["example .com", "a space"],
		["https://example.com", "a URL"],
		["-example.com", "a leading hyphen"],
	])("rejects %s (%s)", (d) => {
		expect(looksLikeDomain(d)).toBe(false);
	});
});

describe("createCatchAllClient", () => {
	it("makes an address on the configured domain", async () => {
		const { address } = await client().create({});
		expect(address).toMatch(/^[a-z0-9-]+@example\.com$/);
	});

	it("makes a different one each time", async () => {
		const c = client();
		const seen = new Set<string>();
		for (let i = 0; i < 25; i++) seen.add((await c.create({})).address);
		expect(seen.size).toBe(25);
	});

	it("uses words by default and characters when asked", async () => {
		expect((await client().create({})).address).toMatch(/^[a-z]+-[a-z]+-\d{2}@example\.com$/);
		expect((await client({ style: "characters" }).create({})).address).toMatch(
			/^[a-z0-9]{10}@example\.com$/,
		);
	});

	// Nothing server-side rejects a duplicate here, so the vault's own addresses are the only
	// guard against handing one login an address that already belongs to another.
	it("never returns an address the vault already holds", async () => {
		const c = client({ style: "characters" });
		const first = (await c.create({})).address;
		const { address } = await c.create({ taken: [first] });
		expect(address).not.toBe(first);
	});

	it("matches the taken list case-insensitively, as mail does", async () => {
		const c = client({ style: "characters" });
		const first = (await c.create({})).address;
		const { address } = await c.create({ taken: [first.toUpperCase()] });
		expect(address).not.toBe(first);
	});

	// Twelve colliding draws means the inputs are wrong, not that luck ran out. Returning a
	// duplicate quietly would be the worse failure. Provoked by pinning the RNG so every draw is
	// identical, which is the only honest way to reach it: the real address space is far too
	// large to exhaust.
	it("refuses rather than repeat when every attempt collides", async () => {
		const c = client({ style: "characters" });
		const pinned = vi
			.spyOn(globalThis.crypto, "getRandomValues")
			.mockImplementation((arr: ArrayBufferView) => {
				new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).fill(0);
				return arr;
			});
		try {
			const only = (await c.create({})).address;
			const err = await c.create({ taken: [only] }).catch((e) => e);
			expect(err).toBeInstanceOf(AliasError);
			expect(err.message).toMatch(/unused/i);
		} finally {
			pinned.mockRestore();
		}
	});

	it("refuses without a domain, and without contacting anything", async () => {
		const err = await createCatchAllClient({})
			.create({})
			.catch((e) => e);
		expect(err).toBeInstanceOf(AliasError);
		expect(err.kind).toBe("config");
	});

	it("refuses a domain that is obviously not one", async () => {
		const err = await createCatchAllClient({ domain: "me@example.com" })
			.create({})
			.catch((e) => e);
		expect(err.kind).toBe("config");
	});

	// There is no account, so there is nothing to report and nothing that can fail.
	it("verifies trivially, because there is nobody to ask", async () => {
		await expect(client().verify()).resolves.toEqual({});
	});
});
