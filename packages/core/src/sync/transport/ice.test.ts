import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveIceUrl, fetchIceServers } from "./ice";

const stubFetch = (body: unknown, ok = true) =>
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok, json: async () => body }) as Response),
	);

afterEach(() => vi.unstubAllGlobals());

describe("deriveIceUrl", () => {
	it("maps the relay URL to its /ice-servers endpoint", () => {
		expect(deriveIceUrl("wss://r.example/")).toBe("https://r.example/ice-servers");
		expect(deriveIceUrl("ws://localhost:7400")).toBe("http://localhost:7400/ice-servers");
	});
	it("returns '' for an unparseable URL", () => {
		expect(deriveIceUrl("not a url")).toBe("");
	});
});

describe("fetchIceServers", () => {
	const server = { urls: ["turn:t.example:3478"], username: "u", credential: "c" };

	it("accepts the { iceServers: [...] } wrapper", async () => {
		stubFetch({ iceServers: [server] });
		expect(await fetchIceServers("https://x/ice")).toEqual([server]);
	});
	it("accepts a bare array", async () => {
		stubFetch([server]);
		expect(await fetchIceServers("https://x/ice")).toEqual([server]);
	});
	it("accepts a single { iceServers: {...} } object", async () => {
		stubFetch({ iceServers: server });
		expect(await fetchIceServers("https://x/ice")).toEqual([server]);
	});
	it("drops entries without urls", async () => {
		stubFetch({ iceServers: [server, { username: "no-urls" }] });
		expect(await fetchIceServers("https://x/ice")).toEqual([server]);
	});
	it("returns [] on non-ok, empty url, or bad json", async () => {
		stubFetch({}, false);
		expect(await fetchIceServers("https://x/ice")).toEqual([]);
		expect(await fetchIceServers("")).toEqual([]);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					({
						ok: true,
						json: async () => {
							throw new Error("bad json");
						},
					}) as unknown as Response,
			),
		);
		expect(await fetchIceServers("https://x/ice")).toEqual([]);
	});
});
