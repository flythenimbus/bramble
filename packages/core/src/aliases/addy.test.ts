import { afterEach, describe, expect, it, vi } from "vitest";
import { createAddyClient } from "./addy";
import { AliasError } from "./types";

afterEach(() => vi.unstubAllGlobals());

/** Install a fetch stub; returns the recorded calls. */
function route(handler: (url: string, init: RequestInit) => Response): {
	url: string;
	init: RequestInit;
}[] {
	const calls: { url: string; init: RequestInit }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			const i = init ?? {};
			calls.push({ url: String(url), init: i });
			return handler(String(url), i);
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

const CREATED = { data: { email: "w40myp02@anonaddy.com" } };

describe("createAddyClient", () => {
	it("creates an alias and returns the address", async () => {
		route(() => json(CREATED, 201));
		const c = createAddyClient({ domain: "anonaddy.com" }, "key");
		await expect(c.create({})).resolves.toEqual({ address: "w40myp02@anonaddy.com" });
	});

	// Laravel decides between a JSON error and a redirect to its web login from these; a redirect
	// reaches a browser as an opaque failure rather than "bad key".
	it("sends the headers that keep Addy answering as an API", async () => {
		const calls = route(() => json(CREATED, 201));
		await createAddyClient({ domain: "anonaddy.com" }, "key").create({});
		const h = only(calls).init.headers as Record<string, string>;
		expect(h.Authorization).toBe("Bearer key");
		expect(h.Accept).toBe("application/json");
		expect(h["X-Requested-With"]).toBe("XMLHttpRequest");
	});

	it("never sends ambient cookies and never follows redirects", async () => {
		const calls = route(() => json(CREATED, 201));
		await createAddyClient({ domain: "anonaddy.com" }, "key").create({});
		expect(only(calls).init.credentials).toBe("omit");
		expect(only(calls).init.redirect).toBe("manual");
	});

	// Measured: omitting it applied the account's own default. Sending one anyway would override
	// a choice the user already made at the provider.
	it("omits format unless one was chosen", async () => {
		const calls = route(() => json(CREATED, 201));
		await createAddyClient({ domain: "anonaddy.com" }, "key").create({});
		expect(JSON.parse(only(calls).init.body as string)).toEqual({ domain: "anonaddy.com" });

		const withFormat = route(() => json(CREATED, 201));
		await createAddyClient({ domain: "anonaddy.com", format: "uuid" }, "key").create({});
		expect(JSON.parse(only(withFormat).init.body as string).format).toBe("uuid");
	});

	// Addy cannot generate without a domain, so this fails before spending a request that could
	// only be rejected.
	it("refuses to create without a domain, without calling out", async () => {
		const calls = route(() => json(CREATED, 201));
		const err = await createAddyClient({}, "key")
			.create({})
			.catch((e) => e);
		expect(err).toBeInstanceOf(AliasError);
		expect(err.kind).toBe("config");
		expect(calls).toHaveLength(0);
	});

	it("reports the account's alias allowance", async () => {
		route(() =>
			json({
				data: {
					username: "flythenimbus",
					active_shared_domain_alias_count: 1,
					active_shared_domain_alias_limit: 10,
				},
			}),
		);
		const acct = await createAddyClient({}, "key").verify();
		expect(acct).toEqual({ label: "flythenimbus", quota: { used: 1, limit: 10 } });
	});

	// A used count with no limit cannot be rendered as an allowance, and inventing a limit would
	// misreport how much room is left.
	it("reports no quota when the provider gives only half of it", async () => {
		route(() => json({ data: { active_shared_domain_alias_count: 1 } }));
		await expect(createAddyClient({}, "key").verify()).resolves.toEqual({
			label: undefined,
			quota: undefined,
		});
	});

	// The allowance is counted over shared domains only, so a domain the user brought must be
	// distinguishable or the UI quotes a limit that does not apply to it.
	it("marks which domains are the provider's and which are the user's own", async () => {
		route(() =>
			json({
				data: ["anonaddy.com", "anonaddy.me", "you.anonaddy.me", "mail.example.com"],
				sharedDomains: ["anonaddy.com", "anonaddy.me"],
				defaultAliasDomain: "anonaddy.me",
			}),
		);
		await expect(createAddyClient({}, "key").domains?.()).resolves.toEqual({
			options: [
				{ domain: "anonaddy.com", shared: true },
				{ domain: "anonaddy.me", shared: true },
				{ domain: "you.anonaddy.me", shared: false },
				{ domain: "mail.example.com", shared: false },
			],
			default: "anonaddy.me",
		});
	});

	// An older or self-hosted Addy that does not send sharedDomains: treat every domain as shared,
	// which is the cautious reading. Claiming a custom domain is unlimited when it is not would
	// have someone hit a wall with no warning.
	it("treats every domain as shared when the provider does not say", async () => {
		route(() => json({ data: ["anonaddy.me", "mail.example.com"] }));
		const d = await createAddyClient({}, "key").domains?.();
		expect(d?.options.every((o) => o.shared)).toBe(true);
	});

	it("strips a trailing slash from a self-hosted base URL", async () => {
		const calls = route(() => json(CREATED, 201));
		await createAddyClient({ baseUrl: "https://addy.example.com/", domain: "d" }, "k").create({});
		expect(only(calls).url).toBe("https://addy.example.com/api/v1/aliases");
	});
});
