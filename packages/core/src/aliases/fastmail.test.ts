import { afterEach, describe, expect, it, vi } from "vitest";
import { createFastmailClient } from "./fastmail";
import { AliasError } from "./types";

afterEach(() => vi.unstubAllGlobals());

const SESSION_URL = "https://api.fastmail.com/jmap/session";
// Measured: the session names a per-datacentre host, not the session's own.
const API_URL = "https://phl.api.fastmail.com/jmap/api/";
const MASKED_EMAIL = "https://www.fastmail.com/dev/maskedemail";

type Call = { url: string; init: RequestInit };

/** Install a fetch stub; returns the recorded calls. */
function route(handler: (url: string, init: RequestInit) => Response): Call[] {
	const calls: Call[] = [];
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

/** What the client actually sent, decoded. Bodies cross the transport as UTF-8 bytes. */
function sentBody(init: RequestInit | undefined): {
	using: string[];
	methodCalls: [string, Record<string, unknown>, string][];
} {
	if (!init?.body) throw new Error("no request body was sent");
	return JSON.parse(new TextDecoder().decode(init.body as Uint8Array));
}

/** The session as measured against a live account (November 2026), trimmed to what matters. */
const session = (over: Record<string, unknown> = {}) =>
	json({
		apiUrl: API_URL,
		username: "me@fastmail.com",
		primaryAccounts: { [MASKED_EMAIL]: "u123", "urn:ietf:params:jmap:core": "u123" },
		capabilities: { [MASKED_EMAIL]: {}, "urn:ietf:params:jmap:core": {} },
		...over,
	});

/** A JMAP reply carrying one method response. */
const reply = (name: string, args: Record<string, unknown>) =>
	json({ methodResponses: [[name, args, "0"]], sessionState: "s1" });

/** The measured create reply: server-set properties only, under the creation id that was sent. */
function created(init: RequestInit, email = "last.soap4530@fastmail.com") {
	const [, args] = sentBody(init).methodCalls[0] ?? [];
	const cid = Object.keys((args?.create as object) ?? {})[0] ?? "";
	return reply("MaskedEmail/set", {
		accountId: "u123",
		created: { [cid]: { id: "masked-1", email, url: null, createdBy: "API Token: Bramble" } },
		notCreated: null,
	});
}

/** Session first, then whatever the API answers. */
const fastmail = (api: (init: RequestInit) => Response) =>
	route((url, init) => (url === SESSION_URL ? session() : api(init)));

const client = (key = "key") => createFastmailClient({}, key);

const failure = (p: Promise<unknown>) => p.then(() => undefined).catch((e) => e as AliasError);

describe("createFastmailClient", () => {
	it("returns the address Fastmail created", async () => {
		fastmail((init) => created(init));
		await expect(client().create({ site: "example.com" })).resolves.toEqual({
			address: "last.soap4530@fastmail.com",
		});
	});

	it("discovers the API from the session, then posts to the apiUrl it names", async () => {
		const calls = fastmail((init) => created(init));
		await client().create({});
		expect(calls.map((c) => c.url)).toEqual([SESSION_URL, API_URL]);
		const body = sentBody(calls[1]?.init);
		expect(body.using).toEqual(["urn:ietf:params:jmap:core", MASKED_EMAIL]);
		expect(body.methodCalls[0]?.[0]).toBe("MaskedEmail/set");
		expect(body.methodCalls[0]?.[1].accountId).toBe("u123");
	});

	it("sends the token as a Bearer, with no cookies and no redirect following, on every request", async () => {
		const calls = fastmail((init) => created(init));
		await client("fmu1-secret").create({});
		for (const c of calls) {
			expect((c.init.headers as Record<string, string>).Authorization).toBe("Bearer fmu1-secret");
			expect(c.init.credentials).toBe("omit");
			expect(c.init.redirect).toBe("manual");
		}
	});

	// Fastmail's default state is `pending`, which it deletes 24 hours later unless mail arrives.
	// `forDomain` wants an origin, and the description is left empty as Fastmail asks of integrators.
	it("creates the address enabled, for the site's origin, with no description", async () => {
		const calls = fastmail((init) => created(init));
		await client().create({ site: "example.com", description: "Bramble (example.com)" });
		const create = sentBody(calls[1]?.init).methodCalls[0]?.[1].create as Record<string, unknown>;
		expect(Object.values(create)).toEqual([
			{ state: "enabled", forDomain: "https://example.com", description: "" },
		]);
	});

	it("leaves forDomain empty when it does not know the site", async () => {
		const calls = fastmail((init) => created(init));
		await client().create({});
		const create = sentBody(calls[1]?.init).methodCalls[0]?.[1].create as Record<string, unknown>;
		expect(Object.values(create)).toEqual([{ state: "enabled", forDomain: "", description: "" }]);
	});

	// The session names where the token goes next, so a spoofed one could harvest it.
	it.each([
		["another host", "https://evil.example/jmap/api/"],
		["a lookalike host", "https://api.fastmail.com.evil.example/jmap/api/"],
		["plain http", "http://phl.api.fastmail.com/jmap/api/"],
	])("refuses to send the token to an apiUrl on %s", async (_why, apiUrl) => {
		const calls = route(() => session({ apiUrl }));
		const err = await failure(client().create({}));
		expect(err).toBeInstanceOf(AliasError);
		expect(err?.kind).toBe("provider");
		expect(calls).toHaveLength(1);
	});

	it("follows an apiUrl on the session's own host", async () => {
		const calls = route((url, init) =>
			url === SESSION_URL
				? session({ apiUrl: "https://api.fastmail.com/jmap/api/" })
				: created(init),
		);
		await client().create({});
		expect(calls[1]?.url).toBe("https://api.fastmail.com/jmap/api/");
	});

	// A token made with other scopes but not Masked Email authenticates fine and can do nothing here.
	it("reports a token without Masked Email access as an auth failure, before any API call", async () => {
		const calls = route(() =>
			session({ primaryAccounts: { "urn:ietf:params:jmap:mail": "u123" } }),
		);
		const err = await failure(client().create({}));
		expect(err?.kind).toBe("auth");
		expect(calls).toHaveLength(1);
	});

	it("reports a rejected token as an auth failure", async () => {
		route(() => new Response("Invalid Authorization bearer parameters", { status: 401 }));
		expect((await failure(client().create({})))?.kind).toBe("auth");
	});

	// JMAP reports a failed method inside a 200, so the status alone says nothing.
	it("reads a method error out of a 200, with Fastmail's own words", async () => {
		fastmail(() =>
			reply("error", {
				type: "accountNotFound",
				description: "accountId not valid for logged in user",
			}),
		);
		const err = await failure(client().create({}));
		expect(err?.kind).toBe("auth");
		expect(err?.providerMessage).toBe("accountId not valid for logged in user");
	});

	it.each([
		["rateLimit", "rate-limit"],
		["overQuota", "quota"],
		["forbidden", "auth"],
		["invalidProperties", "provider"],
	])("reads a create refused with %s as %s", async (type, kind) => {
		fastmail((init) => {
			const [, args] = sentBody(init).methodCalls[0] ?? [];
			const cid = Object.keys((args?.create as object) ?? {})[0] ?? "";
			return reply("MaskedEmail/set", {
				accountId: "u123",
				created: null,
				notCreated: { [cid]: { type, description: "Fastmail said no" } },
			});
		});
		const err = await failure(client().create({}));
		expect(err?.kind).toBe(kind);
		expect(err?.providerMessage).toBe("Fastmail said no");
	});

	// The address is about to be written into a vault entry, so a reply without one is a failure.
	it("treats a reply with no created address as a provider failure", async () => {
		fastmail(() => reply("MaskedEmail/set", { accountId: "u123", created: {}, notCreated: null }));
		expect((await failure(client().create({})))?.kind).toBe("provider");
	});

	it("verifies with an empty lookup that reads no address, and reports the login", async () => {
		const calls = fastmail(() =>
			reply("MaskedEmail/get", { accountId: "u123", state: "", list: [], notFound: [] }),
		);
		await expect(client().verify()).resolves.toEqual({ label: "me@fastmail.com" });
		const [name, args] = sentBody(calls[1]?.init).methodCalls[0] ?? [];
		expect(name).toBe("MaskedEmail/get");
		expect(args).toEqual({ accountId: "u123", ids: [] });
	});

	it("strips a trailing slash from a configured base URL", async () => {
		const calls = route(() => json({}, 401));
		await failure(createFastmailClient({ baseUrl: "https://jmap.example.com/" }, "k").verify());
		expect(calls[0]?.url).toBe("https://jmap.example.com/jmap/session");
	});
});
