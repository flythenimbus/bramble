import { afterEach, describe, expect, it, vi } from "vitest";
import { createSimpleLoginClient } from "./simplelogin";

afterEach(() => vi.unstubAllGlobals());

function route(handler: () => Response): { url: string; init: RequestInit }[] {
	const calls: { url: string; init: RequestInit }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			calls.push({ url: String(url), init: init ?? {} });
			return handler();
		}),
	);
	return calls;
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The single request the call under test made. Throws rather than returning undefined, so a
 * test that expected a request and got none fails saying so. */
function only(calls: { url: string; init: RequestInit }[]): { url: string; init: RequestInit } {
	if (calls.length !== 1) throw new Error(`expected exactly 1 request, saw ${calls.length}`);
	return calls[0] as { url: string; init: RequestInit };
}

const CREATED = { email: "example.reentry351@simplelogin.com" };

describe("createSimpleLoginClient", () => {
	it("creates an alias and returns the address", async () => {
		route(() => json(CREATED, 201));
		await expect(createSimpleLoginClient({}, "key").create({})).resolves.toEqual({
			address: "example.reentry351@simplelogin.com",
		});
	});

	// `Authentication`, not `Authorization`, and no Bearer prefix. Wrong either way, it fails as a
	// 401 indistinguishable from a bad key.
	it("authenticates with the Authentication header and a bare key", async () => {
		const calls = route(() => json(CREATED, 201));
		await createSimpleLoginClient({}, "key").create({});
		const h = only(calls).init.headers as Record<string, string>;
		expect(h.Authentication).toBe("key");
		expect(h.Authorization).toBeUndefined();
	});

	it("never sends ambient cookies and never follows redirects", async () => {
		const calls = route(() => json(CREATED, 201));
		await createSimpleLoginClient({}, "key").create({});
		expect(only(calls).init.credentials).toBe("omit");
		expect(only(calls).init.redirect).toBe("manual");
	});

	// A query parameter, not a body field, and it shapes the visible local part in word mode.
	it("passes the site as a hostname query parameter", async () => {
		const calls = route(() => json(CREATED, 201));
		await createSimpleLoginClient({}, "key").create({ site: "example.com" });
		expect(only(calls).url).toContain("hostname=example.com");
	});

	// The site is passed as given: SimpleLogin does its own reduction server-side, so doing it
	// here would need a public-suffix list in core to reach the same answer.
	it("does not reduce the hostname it is given", async () => {
		const calls = route(() => json(CREATED, 201));
		await createSimpleLoginClient({}, "key").create({ site: "accounts.example.co.uk" });
		expect(only(calls).url).toContain("hostname=accounts.example.co.uk");
	});

	it("omits mode unless one was chosen, and sends it when it was", async () => {
		const bare = route(() => json(CREATED, 201));
		await createSimpleLoginClient({}, "key").create({});
		expect(only(bare).url).not.toContain("mode=");

		const uuid = route(() => json(CREATED, 201));
		await createSimpleLoginClient({ mode: "uuid" }, "key").create({});
		expect(only(uuid).url).toContain("mode=uuid");
	});

	it("sends a description as the note", async () => {
		const calls = route(() => json(CREATED, 201));
		await createSimpleLoginClient({}, "key").create({ description: "Bramble" });
		expect(JSON.parse(only(calls).init.body as string)).toEqual({ note: "Bramble" });
	});

	// No allowance is reported anywhere in this API, and the premium flag is a different question.
	it("reports no quota, because the provider does not give one", async () => {
		route(() => json({ email: "someone@pm.me", is_premium: true }));
		await expect(createSimpleLoginClient({}, "key").verify()).resolves.toEqual({
			label: "someone@pm.me",
		});
	});
});

// Custom domains are only reachable through the custom endpoint: the random one always uses the
// account's default domain. See docs/email-aliases.md.
describe("createSimpleLoginClient on a chosen domain", () => {
	const OPTIONS = {
		can_create: true,
		prefix_suggestion: "example",
		suffixes: [
			{ suffix: ".word123@simplelogin.com", signed_suffix: "shared.sig", is_custom: false },
			{ suffix: "@mail.example.com", signed_suffix: "custom.sig", is_custom: true },
		],
	};
	const MAILBOXES = {
		mailboxes: [
			{ id: 7, default: false },
			{ id: 42, default: true },
		],
	};

	/** Route by path, so the three-call custom flow can be exercised end to end. */
	function routeAll(): { url: string; init: RequestInit }[] {
		const calls: { url: string; init: RequestInit }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL, init?: RequestInit) => {
				const u = String(url);
				calls.push({ url: u, init: init ?? {} });
				if (u.includes("/alias/options")) return json(OPTIONS);
				if (u.includes("/mailboxes")) return json(MAILBOXES);
				return json({ email: "example-a1b2c3d4@mail.example.com" }, 201);
			}),
		);
		return calls;
	}

	it("lists every domain the account can use, marking the user's own", async () => {
		route(() => json(OPTIONS));
		await expect(createSimpleLoginClient({}, "key").domains?.()).resolves.toEqual({
			options: [
				{ domain: "simplelogin.com", shared: true },
				{ domain: "mail.example.com", shared: false },
			],
		});
	});

	it("creates through the custom endpoint with the signed suffix for that domain", async () => {
		const calls = routeAll();
		const c = createSimpleLoginClient({ domain: "mail.example.com" }, "key");
		await expect(c.create({ site: "example.com" })).resolves.toEqual({
			address: "example-a1b2c3d4@mail.example.com",
		});
		const create = calls.find((x) => x.url.includes("/v3/alias/custom/new"));
		const body = JSON.parse(create?.init.body as string);
		expect(body.signed_suffix).toBe("custom.sig");
		// The default mailbox, not merely the first one the account happens to list.
		expect(body.mailbox_ids).toEqual([42]);
	});

	// A custom domain's suffix carries no randomness of its own, so a fixed site-derived prefix
	// would collide on the second alias for the same site.
	it("gives a custom-domain prefix entropy of its own", async () => {
		const calls = routeAll();
		await createSimpleLoginClient({ domain: "mail.example.com" }, "key").create({
			site: "example.com",
		});
		const body = JSON.parse(calls.find((x) => x.url.includes("/custom/new"))?.init.body as string);
		expect(body.alias_prefix).toMatch(/^example-[0-9a-f]{8}$/);
	});

	// A shared suffix already ends in a random word, so the prefix stays the readable site name.
	it("leaves a shared-domain prefix as the site name", async () => {
		const calls = routeAll();
		await createSimpleLoginClient({ domain: "simplelogin.com" }, "key").create({
			site: "example.com",
		});
		const body = JSON.parse(calls.find((x) => x.url.includes("/custom/new"))?.init.body as string);
		expect(body.alias_prefix).toBe("example");
	});

	it("uses the random endpoint when no domain is chosen", async () => {
		const calls = routeAll();
		await createSimpleLoginClient({}, "key").create({ site: "example.com" });
		expect(calls.some((x) => x.url.includes("/alias/random/new"))).toBe(true);
		expect(calls.some((x) => x.url.includes("/custom/new"))).toBe(false);
	});

	it("names the remedy when the configured domain is gone", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) =>
				String(url).includes("/alias/options") ? json(OPTIONS) : json(MAILBOXES),
			),
		);
		const err = await createSimpleLoginClient({ domain: "gone.example" }, "key")
			.create({})
			.catch((e) => e);
		expect(err.kind).toBe("config");
		expect(err.message).toContain("gone.example");
	});

	it("reports an account that cannot create as a quota failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) =>
				String(url).includes("/alias/options")
					? json({ ...OPTIONS, can_create: false })
					: json(MAILBOXES),
			),
		);
		const err = await createSimpleLoginClient({ domain: "mail.example.com" }, "key")
			.create({})
			.catch((e) => e);
		expect(err.kind).toBe("quota");
	});
});
