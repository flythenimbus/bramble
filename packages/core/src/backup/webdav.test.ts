import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebdavTarget } from "./webdav";

const CFG = {
	kind: "webdav",
	serverUrl: "http://localhost:8080/remote.php/dav/files/admin/",
	username: "admin",
	password: "Bramble-test-123",
} as const;

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

const CSRF_401 = `<?xml version="1.0" encoding="utf-8"?>
<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">
  <s:exception>Sabre\\DAV\\Exception\\NotAuthenticated</s:exception>
  <s:message>CSRF check not passed.</s:message>
</d:error>`;

describe("createWebdavTarget", () => {
	// A logged-in browser session for the same host outranks our Basic header on
	// Nextcloud and then fails its CSRF check, so cookies must never be attached.
	it("omits ambient cookies on every request", async () => {
		const calls = route(() => new Response("", { status: 201 }));
		const t = createWebdavTarget(CFG);
		await t.put("bramble/x.bramble", new Uint8Array([1]), "application/octet-stream");
		expect(calls.length).toBeGreaterThan(0);
		for (const c of calls) expect(c.init.credentials).toBe("omit");
	});

	// The folder now arrives in the key, so it must appear exactly once in the URL.
	it("puts a folder-prefixed key at the right depth", async () => {
		const calls = route(() => new Response("", { status: 201 }));
		await createWebdavTarget(CFG).put("backups/x.bramble", new Uint8Array([1]));
		const put = calls.find((c) => c.init.method === "PUT");
		expect(put?.url).toBe("http://localhost:8080/remote.php/dav/files/admin/backups/x.bramble");
	});

	it("creates each intermediate collection, outermost first", async () => {
		const calls = route(() => new Response("", { status: 201 }));
		await createWebdavTarget(CFG).put("a/b/x.bramble", new Uint8Array([1]));
		const mkcols = calls.filter((c) => c.init.method === "MKCOL").map((c) => c.url);
		expect(mkcols).toEqual([
			"http://localhost:8080/remote.php/dav/files/admin/a",
			"http://localhost:8080/remote.php/dav/files/admin/a/b",
		]);
	});

	it("sends basic auth", async () => {
		const calls = route(() => new Response("", { status: 201 }));
		await createWebdavTarget(CFG).put("bramble/x.bramble", new Uint8Array([1]));
		const put = calls.find((c) => c.init.method === "PUT");
		const headers = put?.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Basic ${btoa("admin:Bramble-test-123")}`);
	});

	it("surfaces the server's explanation in the thrown error", async () => {
		route((_url, init) =>
			init.method === "PUT"
				? new Response(CSRF_401, { status: 401 })
				: new Response("", { status: 201 }),
		);
		await expect(
			createWebdavTarget(CFG).put("bramble/x.bramble", new Uint8Array([1])),
		).rejects.toThrow("WebDAV PUT failed (401): CSRF check not passed.");
	});

	// Nextcloud's brute-force throttle keeps rejecting after the credentials are fixed.
	it("explains a throttling 429", async () => {
		route((_url, init) =>
			init.method === "PUT" ? new Response("", { status: 429 }) : new Response("", { status: 201 }),
		);
		await expect(
			createWebdavTarget(CFG).put("bramble/x.bramble", new Uint8Array([1])),
		).rejects.toThrow("WebDAV PUT failed (429): rate-limited by the server");
	});

	it("still reports the status when the body is not sabre xml", async () => {
		route((_url, init) =>
			init.method === "PUT"
				? new Response("nope", { status: 401 })
				: new Response("", { status: 201 }),
		);
		await expect(
			createWebdavTarget(CFG).put("bramble/x.bramble", new Uint8Array([1])),
		).rejects.toThrow("WebDAV PUT failed (401)");
	});
});
