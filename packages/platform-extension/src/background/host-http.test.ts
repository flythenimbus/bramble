import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

// The background's backup requests run in the crypto host as jobs, because a Chrome service
// worker cannot hold one open for a large upload. What has to hold: the body reaches the host's
// fetch intact, by the right route for its size, and nothing staged for it is left behind.

vi.mock("./offscreen-client", async () => {
	const host = await import("../http-host");
	return {
		sendToOffscreen: async (msg: { type: string; payload: unknown }) => {
			if (msg.type === "HTTP_JOB_START") {
				return { ok: true, data: await host.startHttpJob(msg.payload as never) };
			}
			if (msg.type === "HTTP_JOB_POLL") {
				return { ok: true, data: host.pollHttpJob((msg.payload as { id: string }).id) };
			}
			return { ok: false, error: "unexpected" };
		},
	};
});

const { hostHttp } = await import("./host-http");
const idb = await import("../files/idb");

afterEach(() => vi.unstubAllGlobals());

function fetchRecorder(status = 201) {
	const calls: { url: string; init: RequestInit }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return new Response("done", { status });
		}),
	);
	return calls;
}

const bodyBytes = async (body: BodyInit | null | undefined) =>
	new Uint8Array(await new Response(body).arrayBuffer());

describe("hostHttp", () => {
	it("sends a small body inline and returns the host's response", async () => {
		const calls = fetchRecorder();
		const res = await hostHttp.send({
			method: "PUT",
			url: "https://dav.example/x",
			headers: { Authorization: "Basic abc" },
			body: new Uint8Array([1, 2, 3]),
		});
		expect(res).toEqual({ status: 201, ok: true, body: new TextEncoder().encode("done") });
		expect(calls[0]?.init).toMatchObject({
			method: "PUT",
			credentials: "omit",
			redirect: "manual",
		});
		expect(await bodyBytes(calls[0]?.init.body)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("stages a large body for the host and drops it afterwards", async () => {
		const calls = fetchRecorder();
		const put = vi.spyOn(idb, "putHandoff");
		const size = 600 * 1024;
		await hostHttp.send({
			method: "PUT",
			url: "https://dav.example/big",
			body: { size, read: async (o, l) => Uint8Array.from({ length: l }, (_, i) => (o + i) % 251) },
		});
		const sent = await bodyBytes(calls[0]?.init.body);
		expect(sent.length).toBe(size);
		expect(sent[size - 1]).toBe((size - 1) % 251);
		const token = await put.mock.results[0]?.value;
		expect(await idb.readHandoff(token)).toBeNull();
	});

	it("fails rather than hangs when the host lost the job", async () => {
		const host = await import("../http-host");
		vi.spyOn(host, "pollHttpJob").mockReturnValueOnce({
			done: true,
			error: "the request was lost when the crypto host restarted",
		});
		fetchRecorder();
		await expect(hostHttp.send({ method: "GET", url: "https://dav.example/" })).rejects.toThrow(
			/lost/,
		);
	});
});
