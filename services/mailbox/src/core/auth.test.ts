import { HEADERS, MAX_CLOCK_SKEW_MS } from "@vault/core/src/sync/mailbox/protocol.ts";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	makeDevice,
	makeServer,
	type ServerOpts,
	type TestDevice,
	type TestServer,
} from "../test/harness.ts";
import { signedJson } from "./auth.ts";

const TOKEN = "a-private-token-0123";

function withEcho(opts: ServerOpts = {}): TestServer {
	const server = makeServer(opts);
	server.app.post("/v1/echo", ...signedJson(z.object({ n: z.number() }), 1024), (c) =>
		c.json({ sigKey: c.var.sigKey, body: c.req.valid("json") }),
	);
	return server;
}

async function send(server: TestServer, headers: Record<string, string>, bytes: Uint8Array) {
	return server.app.request("/v1/echo", {
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body: bytes as Uint8Array<ArrayBuffer>,
	});
}

describe("signed requests", () => {
	let server: TestServer;
	let a: TestDevice;
	let b: TestDevice;
	beforeEach(async () => {
		server = withEcho();
		a = await makeDevice(server);
		b = await makeDevice(server);
	});

	it("accepts a correctly signed request and exposes the signer", async () => {
		const res = await a.request("POST", "/v1/echo", { n: 1 });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ sigKey: a.sigKey, body: { n: 1 } });
	});

	it("refuses a signature by a different key", async () => {
		const bytes = a.encode({ n: 1 });
		const headers = await a.headers("POST", "/v1/echo", bytes);
		headers[HEADERS.key] = b.sigKey;
		const res = await send(server, headers, bytes);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "bad_signature" });
	});

	it("refuses a body that differs from the signed hash", async () => {
		const headers = await a.headers("POST", "/v1/echo", a.encode({ n: 1 }));
		const res = await send(server, headers, a.encode({ n: 2 }));
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "bad_signature" });
	});

	it("answers a clock outside the window with the server's time", async () => {
		const res = await a.request(
			"POST",
			"/v1/echo",
			{ n: 1 },
			{ time: server.clock.now - MAX_CLOCK_SKEW_MS - 1 },
		);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "stale_time", serverTime: server.clock.now });
	});

	it("accepts a clock at the edge of the window", async () => {
		const res = await a.request(
			"POST",
			"/v1/echo",
			{ n: 1 },
			{ time: server.clock.now + MAX_CLOCK_SKEW_MS },
		);
		expect(res.status).toBe(200);
	});

	it("refuses a JSON body larger than the limit before parsing it", async () => {
		const res = await a.request("POST", "/v1/echo", { n: 1, pad: "x".repeat(2000) });
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "too_large" });
	});

	it("answers a body the schema rejects with bad_request, without echoing it", async () => {
		const res = await a.request("POST", "/v1/echo", { n: "x" });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "bad_request" });
	});

	it("refuses a signed body sent without a JSON content type", async () => {
		const bytes = a.encode({ n: 1 });
		const headers = await a.headers("POST", "/v1/echo", bytes);
		const res = await server.app.request("/v1/echo", {
			method: "POST",
			headers,
			body: bytes as Uint8Array<ArrayBuffer>,
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "bad_request" });
	});

	it("refuses missing or malformed signing headers as bad_signature", async () => {
		const bytes = a.encode({ n: 1 });
		const headers = await a.headers("POST", "/v1/echo", bytes);
		const { [HEADERS.sig]: _dropped, ...unsigned } = headers;
		expect((await send(server, unsigned, bytes)).status).toBe(401);
		const badTime = await send(server, { ...headers, [HEADERS.time]: "soon" }, bytes);
		expect(badTime.status).toBe(401);
		expect(await badTime.json()).toEqual({ error: "bad_signature" });
	});
});

describe("private servers", () => {
	it("refuses a request without the token when one is configured, but keeps /health open", async () => {
		const server = withEcho({ token: TOKEN });
		const device = await makeDevice(server);
		const without = await device.request("POST", "/v1/echo", { n: 1 });
		expect(without.status).toBe(403);
		expect(await without.json()).toEqual({ error: "token_required" });
		expect(
			(await device.request("POST", "/v1/echo", { n: 1 }, { token: "wrong-token-0123456" })).status,
		).toBe(403);
		expect((await device.request("POST", "/v1/echo", { n: 1 }, { token: TOKEN })).status).toBe(200);
		expect((await server.app.request("/health")).status).toBe(200);
	});
});
