import { afterEach, describe, expect, it, vi } from "vitest";
import { createDropboxTarget } from "./dropbox";

const UPLOAD = "https://content.dropboxapi.com/2/files/upload";
const LIST = "https://api.dropboxapi.com/2/files/list_folder";
const DELETE = "https://api.dropboxapi.com/2/files/delete_v2";
const TOKEN = "https://api.dropboxapi.com/oauth2/token";

afterEach(() => vi.unstubAllGlobals());

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Install a fetch stub routed by URL; returns the recorded calls. */
function route(handler: Handler): { url: string; init: RequestInit }[] {
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

const ok = (body: unknown = {}): Response => new Response(JSON.stringify(body), { status: 200 });
const status = (s: number, body: unknown = {}): Response =>
	new Response(JSON.stringify(body), { status: s });
const authOf = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;
const argOf = (init: RequestInit) =>
	JSON.parse((init.headers as Record<string, string>)["Dropbox-API-Arg"]!);

describe("createDropboxTarget", () => {
	it("uploads to the content endpoint with the app-folder path and bearer auth", async () => {
		const calls = route(() => ok());
		const t = createDropboxTarget({ kind: "dropbox", refreshToken: "RT", accessToken: "AT" });
		await t.put("bramble/bramble-x.bramble", new Uint8Array([1, 2, 3]));

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(UPLOAD);
		expect(authOf(calls[0]!.init)).toBe("Bearer AT");
		expect(argOf(calls[0]!.init).path).toBe("/bramble/bramble-x.bramble");
	});

	it("nests uploads under a configured subfolder", async () => {
		const calls = route(() => ok());
		const t = createDropboxTarget({
			kind: "dropbox",
			refreshToken: "RT",
			accessToken: "AT",
			path: "/Backups",
		});
		await t.put("bramble/bramble-x.bramble", new Uint8Array([1]));
		expect(argOf(calls[0]!.init).path).toBe("/Backups/bramble/bramble-x.bramble");
	});

	it("mints an access token from the refresh token before the first call", async () => {
		const calls = route((url) => (url === TOKEN ? ok({ access_token: "MINTED" }) : ok()));
		const t = createDropboxTarget({ kind: "dropbox", refreshToken: "RT" });
		await t.put("bramble/x.bramble", new Uint8Array([9]));

		expect(calls[0]!.url).toBe(TOKEN);
		expect(calls[1]!.url).toBe(UPLOAD);
		expect(authOf(calls[1]!.init)).toBe("Bearer MINTED");
	});

	it("re-mints and retries once on a 401", async () => {
		let uploads = 0;
		const calls = route((url) => {
			if (url === TOKEN) return ok({ access_token: "FRESH" });
			if (url === UPLOAD) {
				uploads++;
				return uploads === 1 ? status(401) : ok();
			}
			return ok();
		});
		const t = createDropboxTarget({ kind: "dropbox", refreshToken: "RT", accessToken: "STALE" });
		await t.put("bramble/x.bramble", new Uint8Array([1]));

		expect(uploads).toBe(2);
		const last = calls[calls.length - 1]!;
		expect(last.url).toBe(UPLOAD);
		expect(authOf(last.init)).toBe("Bearer FRESH");
	});

	it("lists files under the folder and maps names back to keys", async () => {
		const calls = route((url) =>
			url === LIST
				? ok({
						entries: [
							{
								".tag": "file",
								name: "bramble-1.bramble",
								size: 10,
								server_modified: "2026-01-01T00:00:00Z",
							},
							{ ".tag": "folder", name: "sub" },
						],
					})
				: ok(),
		);
		const t = createDropboxTarget({ kind: "dropbox", refreshToken: "RT", accessToken: "AT" });
		const items = await t.list("bramble/");

		expect(JSON.parse(calls[0]!.init.body as string).path).toBe("/bramble");
		expect(items).toEqual([
			{ key: "bramble/bramble-1.bramble", size: 10, lastModified: "2026-01-01T00:00:00Z" },
		]);
	});

	it("returns an empty list when the folder doesn't exist yet (409)", async () => {
		route((url) => (url === LIST ? status(409, { error_summary: "path/not_found/" }) : ok()));
		const t = createDropboxTarget({ kind: "dropbox", refreshToken: "RT", accessToken: "AT" });
		expect(await t.list("bramble/")).toEqual([]);
	});

	it("treats a 409 on delete as success (already gone)", async () => {
		route((url) => (url === DELETE ? status(409) : ok()));
		const t = createDropboxTarget({ kind: "dropbox", refreshToken: "RT", accessToken: "AT" });
		await expect(t.remove("bramble/x.bramble")).resolves.toBeUndefined();
	});

	it("throws on a non-409 delete failure", async () => {
		route((url) => (url === DELETE ? status(500) : ok()));
		const t = createDropboxTarget({ kind: "dropbox", refreshToken: "RT", accessToken: "AT" });
		await expect(t.remove("bramble/x.bramble")).rejects.toThrow(/500/);
	});
});
