import { afterEach, describe, expect, it, vi } from "vitest";
import { PART_SIZE } from "./types";
import { createWebdavTarget } from "./webdav";
import { bytesSource } from "./zip";

const CFG = {
	kind: "webdav",
	serverUrl: "http://localhost:8080/remote.php/dav/files/admin/",
	username: "admin",
	password: "Bramble-test-123",
} as const;

afterEach(() => vi.unstubAllGlobals());

/** What a server answers a Depth 0 PROPFIND with: the stored length of one file. */
const stored = (length: number) =>
	new Response(
		`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/x</d:href><d:propstat><d:prop><d:getcontentlength>${length}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
		{ status: 207 },
	);

/** Install a fetch stub; returns the recorded calls. A PROPFIND the handler leaves alone reports
 * the length the last PUT sent, as an honest server would. */
function route(handler: (url: string, init: RequestInit) => Response | undefined): {
	url: string;
	init: RequestInit;
}[] {
	const calls: { url: string; init: RequestInit }[] = [];
	let lastPut = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			const i = init ?? {};
			calls.push({ url: String(url), init: i });
			if (i.method === "PUT") {
				const body = i.body as Uint8Array | Blob;
				lastPut = body instanceof Blob ? body.size : body.length;
			}
			const answer = handler(String(url), i);
			if (answer) return answer;
			return i.method === "PROPFIND" ? stored(lastPut) : new Response("", { status: 201 });
		}),
	);
	return calls;
}

/** The MOVE the call under test made, or a failure that says there was none. */
function moveOf(calls: { url: string; init: RequestInit }[]): {
	url: string;
	headers: Record<string, string>;
} {
	const m = calls.find((c) => c.init.method === "MOVE");
	if (!m) throw new Error("no MOVE was sent");
	return { url: m.url, headers: m.init.headers as Record<string, string> };
}

const CSRF_401 = `<?xml version="1.0" encoding="utf-8"?>
<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">
  <s:exception>Sabre\\DAV\\Exception\\NotAuthenticated</s:exception>
  <s:message>CSRF check not passed.</s:message>
</d:error>`;

describe("createWebdavTarget", () => {
	// A logged-in browser session for the same host outranks our Basic header on
	// Nextcloud and then fails its CSRF check, so cookies must never be attached.
	it("omits ambient cookies on every request", async () => {
		const calls = route(() => undefined);
		const t = createWebdavTarget(CFG);
		await t.put("bramble/x.bramble", bytesSource(new Uint8Array([1])), "application/octet-stream");
		expect(calls.length).toBeGreaterThan(0);
		for (const c of calls) expect(c.init.credentials).toBe("omit");
	});

	// The folder now arrives in the key, so it must appear exactly once in each URL.
	it("puts a folder-prefixed key at the right depth", async () => {
		const calls = route(() => undefined);
		await createWebdavTarget(CFG).put("backups/x.bramble", bytesSource(new Uint8Array([1])));
		expect(moveOf(calls).headers.Destination).toBe(
			"http://localhost:8080/remote.php/dav/files/admin/backups/x.bramble",
		);
	});

	// Many servers write a PUT in place, so an upload cut off partway would leave a truncated file
	// under a real snapshot name. Written aside and moved, a snapshot name only ever appears on a
	// complete file, because a MOVE within one server is atomic.
	it("writes aside and moves into place, never PUTting the snapshot name itself", async () => {
		const calls = route(() => undefined);
		await createWebdavTarget(CFG).put("backups/x.bramble", bytesSource(new Uint8Array([1])));
		const puts = calls.filter((c) => c.init.method === "PUT").map((c) => c.url);
		expect(puts).toEqual([
			"http://localhost:8080/remote.php/dav/files/admin/backups/.x.bramble.partial",
		]);
		expect(moveOf(calls).url).toBe(
			"http://localhost:8080/remote.php/dav/files/admin/backups/.x.bramble.partial",
		);
		expect(moveOf(calls).headers.Overwrite).toBe("T");
		// The move comes after the write, or it would move nothing.
		expect(calls.findIndex((c) => c.init.method === "MOVE")).toBeGreaterThan(
			calls.findIndex((c) => c.init.method === "PUT"),
		);
	});

	it.each(["PUT", "MOVE"])(
		"deletes the temporary file and fails the backup when the %s fails",
		async (failing) => {
			const calls = route((_url, init) =>
				init.method === failing ? new Response("", { status: 507 }) : undefined,
			);
			await expect(
				createWebdavTarget(CFG).put("backups/x.bramble", bytesSource(new Uint8Array([1]))),
			).rejects.toThrow(`WebDAV ${failing} failed (507)`);
			const del = calls.find((c) => c.init.method === "DELETE");
			expect(del?.url).toBe(
				"http://localhost:8080/remote.php/dav/files/admin/backups/.x.bramble.partial",
			);
			// And the real name was never touched by anything but a successful move.
			expect(calls.some((c) => c.url.endsWith("/backups/x.bramble"))).toBe(false);
		},
	);

	it("creates each intermediate collection, outermost first", async () => {
		const calls = route(() => undefined);
		await createWebdavTarget(CFG).put("a/b/x.bramble", bytesSource(new Uint8Array([1])));
		const mkcols = calls.filter((c) => c.init.method === "MKCOL").map((c) => c.url);
		expect(mkcols).toEqual([
			"http://localhost:8080/remote.php/dav/files/admin/a",
			"http://localhost:8080/remote.php/dav/files/admin/a/b",
		]);
	});

	it("sends basic auth", async () => {
		const calls = route(() => undefined);
		await createWebdavTarget(CFG).put("bramble/x.bramble", bytesSource(new Uint8Array([1])));
		const put = calls.find((c) => c.init.method === "PUT");
		const headers = put?.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Basic ${btoa("admin:Bramble-test-123")}`);
	});

	it("surfaces the server's explanation in the thrown error", async () => {
		route((_url, init) =>
			init.method === "PUT" ? new Response(CSRF_401, { status: 401 }) : undefined,
		);
		await expect(
			createWebdavTarget(CFG).put("bramble/x.bramble", bytesSource(new Uint8Array([1]))),
		).rejects.toThrow("WebDAV PUT failed (401): CSRF check not passed.");
	});

	// Nextcloud's brute-force throttle keeps rejecting after the credentials are fixed.
	it("explains a throttling 429", async () => {
		route((_url, init) => (init.method === "PUT" ? new Response("", { status: 429 }) : undefined));
		await expect(
			createWebdavTarget(CFG).put("bramble/x.bramble", bytesSource(new Uint8Array([1]))),
		).rejects.toThrow("WebDAV PUT failed (429): rate-limited by the server");
	});

	it("still reports the status when the body is not sabre xml", async () => {
		route((_url, init) =>
			init.method === "PUT" ? new Response("nope", { status: 401 }) : undefined,
		);
		await expect(
			createWebdavTarget(CFG).put("bramble/x.bramble", bytesSource(new Uint8Array([1]))),
		).rejects.toThrow("WebDAV PUT failed (401)");
	});

	// A server that took a short body without complaint must not get a snapshot out of it.
	it("checks what the server stored before it gets a snapshot's name", async () => {
		const calls = route((_url, init) => (init.method === "PROPFIND" ? stored(0) : undefined));
		await expect(
			createWebdavTarget(CFG).put("bramble/x.bramble", bytesSource(new Uint8Array([1, 2, 3]))),
		).rejects.toThrow("WebDAV stored 0 bytes of a 3-byte backup");
		expect(calls.some((c) => c.init.method === "MOVE")).toBe(false);
		expect(calls.some((c) => c.init.method === "DELETE")).toBe(true);
	});

	// No standard way to upload in parts, so a large backup goes as one request whose body is read
	// on demand: here, the browser's Blob, never one buffer of the whole file.
	it("sends a large backup as one streamed body", async () => {
		const calls = route(() => undefined);
		const size = PART_SIZE + 3;
		const reads: number[] = [];
		await createWebdavTarget(CFG).put("bramble/x.bramble", {
			size,
			read: async (_offset, length) => {
				reads.push(length);
				return new Uint8Array(length);
			},
		});
		const put = calls.find((c) => c.init.method === "PUT");
		if (!put) throw new Error("no PUT was sent");
		expect(put.init.body).toBeInstanceOf(Blob);
		expect((put.init.body as Blob).size).toBe(size);
		expect(Math.max(...reads)).toBeLessThan(size);
	});
});
