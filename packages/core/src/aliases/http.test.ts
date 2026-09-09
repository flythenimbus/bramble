import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
