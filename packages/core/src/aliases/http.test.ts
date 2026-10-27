import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type HttpRequest, TRANSFER_INTERRUPTED } from "../adapters/http";
import { request } from "./http";
import { AliasError } from "./types";

afterEach(() => vi.unstubAllGlobals());

const Schema = z.object({ email: z.string() });

function reply(res: Response | (() => never)) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => (typeof res === "function" ? res() : res)),
	);
}

const json = (body: unknown, status: number) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const call = () => request("https://p.example/x", { headers: {} }, Schema);

describe("request", () => {
	it("returns the validated body on success", async () => {
		reply(json({ email: "a@b.c" }, 200));
		await expect(call()).resolves.toEqual({ email: "a@b.c" });
	});

	// The value on the other side of this is an address about to be written into a vault entry
	// and handed to a website, so an unrecognised 2xx is a failure rather than a guess.
	it("rejects a 2xx whose shape does not match", async () => {
		reply(json({ nope: true }, 200));
		const err = await call().catch((e) => e);
		expect(err.kind).toBe("provider");
	});

	it.each([
		[401, "auth"],
		[403, "auth"],
		[402, "payment"],
		[429, "rate-limit"],
		[500, "provider"],
	])("maps %i to %s", async (status, kind) => {
		reply(json({ message: "x" }, status));
		const err = await call().catch((e) => e);
		expect(err).toBeInstanceOf(AliasError);
		expect(err.kind).toBe(kind);
		expect(err.status).toBe(status);
	});

	// Measured on two providers: a valid key gets 401 on an unverified account and 402 on a free
	// plan. Both messages are the only thing that tells the user what to actually do.
	it("carries the provider's own message, verbatim", async () => {
		reply(json({ message: "Please verify your email address to continue." }, 401));
		const err = await call().catch((e) => e);
		expect(err.providerMessage).toBe("Please verify your email address to continue.");
		// Kept apart from `message`, which is ours and safe to render however we like.
		expect(err.message).not.toContain("verify your email");
	});

	// Firefox Relay is Django REST Framework, measured: `{"detail":"Invalid token."}`. Its
	// free-plan mask limit is explained the same way, which is the case that most needs words.
	it("accepts `detail` as the message field, as Firefox Relay sends it", async () => {
		reply(json({ detail: "Invalid token." }, 401));
		const err = await call().catch((e) => e);
		expect(err.kind).toBe("auth");
		expect(err.providerMessage).toBe("Invalid token.");
	});

	it("accepts `error` as the message field when `message` is absent", async () => {
		reply(json({ error: "Unauthorized" }, 401));
		const err = await call().catch((e) => e);
		expect(err.providerMessage).toBe("Unauthorized");
	});

	it("leaves providerMessage undefined when the body is not JSON", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("<html>login</html>", { status: 401 })),
		);
		const err = await call().catch((e) => e);
		expect(err.kind).toBe("auth");
		expect(err.providerMessage).toBeUndefined();
	});

	// A redirect out of an API call means the session was rejected, and its destination is an
	// HTML login page with no CORS.
	it("treats a redirect as an auth failure rather than following it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 302, headers: { Location: "/login" } })),
		);
		const err = await call().catch((e) => e);
		expect(err.kind).toBe("auth");
	});

	it("reports a thrown fetch as a network failure", async () => {
		reply(() => {
			throw new TypeError("Failed to fetch");
		});
		const err = await call().catch((e) => e);
		expect(err.kind).toBe("network");
		expect(err.providerMessage).toBe("Failed to fetch");
	});
});

describe("request through an injected transport", () => {
	/** A stub transport, plus the requests it was handed. */
	function transport(res: () => { status: number; ok: boolean; body: Uint8Array }) {
		const sent: HttpRequest[] = [];
		return {
			sent,
			http: {
				send: async (req: HttpRequest) => {
					sent.push(req);
					return res();
				},
			},
		};
	}

	const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

	it("uses the transport instead of fetch, and never touches fetch at all", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const t = transport(() => ({ status: 200, ok: true, body: bytes({ email: "a@b.c" }) }));
		await expect(request("https://p.example/x", { headers: {} }, Schema, t.http)).resolves.toEqual({
			email: "a@b.c",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	// The bodies have to survive a native bridge, so they cross as bytes rather than a string.
	it("hands the transport the method, headers and an encoded body", async () => {
		const t = transport(() => ({ status: 200, ok: true, body: bytes({ email: "a@b.c" }) }));
		await request(
			"https://p.example/x",
			{ method: "POST", headers: { Authorization: "Bearer k" }, body: { note: "hi" } },
			Schema,
			t.http,
		);
		const req = t.sent[0];
		// Throws rather than reading undefined, so "the transport was never called" fails saying so.
		if (!req) throw new Error("the transport was never called");
		expect(req.method).toBe("POST");
		expect(req.url).toBe("https://p.example/x");
		expect(req.headers).toEqual({ Authorization: "Bearer k" });
		expect(JSON.parse(new TextDecoder().decode(req.body as Uint8Array))).toEqual({ note: "hi" });
	});

	// `fetch` reports a refused redirect as an opaque response with status 0; a native transport
	// has no opaque responses and returns the real 3xx. Both mean the session was rejected, so
	// both have to land on the same error.
	it.each([0, 301, 302, 307])("treats status %i as an auth failure", async (status) => {
		const t = transport(() => ({ status, ok: false, body: new Uint8Array() }));
		const err = await request("https://p.example/x", { headers: {} }, Schema, t.http).catch(
			(e) => e,
		);
		expect(err).toBeInstanceOf(AliasError);
		expect(err.kind).toBe("auth");
	});

	// The request may have reached the provider before iOS stopped it, so "could not reach" would be
	// wrong, and a blind retry could make a second alias.
	it("says an interrupted request may have landed, instead of calling it unreachable", async () => {
		const http = {
			send: async () => {
				throw new Error(TRANSFER_INTERRUPTED);
			},
		};
		const err = await request("https://p.example/x", { headers: {} }, Schema, http).catch((e) => e);
		expect(err.kind).toBe("network");
		expect(err.message).toMatch(/closed before the provider answered/i);
		expect(err.message).not.toMatch(/could not reach/i);
		expect(err.providerMessage).toBeUndefined();
	});

	it("reports a throwing transport as a network failure", async () => {
		const http = {
			send: async () => {
				throw new Error("no route to host");
			},
		};
		const err = await request("https://p.example/x", { headers: {} }, Schema, http).catch((e) => e);
		expect(err.kind).toBe("network");
		expect(err.providerMessage).toBe("no route to host");
	});
});
