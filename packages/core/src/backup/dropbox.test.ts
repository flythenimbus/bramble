import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDropboxTarget } from "./dropbox";
import { PART_SIZE } from "./types";
import { bytesSource } from "./zip";

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
		await t.put("bramble/bramble-x.bramble", bytesSource(new Uint8Array([1, 2, 3])));

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
		await t.put("bramble/bramble-x.bramble", bytesSource(new Uint8Array([1])));
		expect(argOf(calls[0]!.init).path).toBe("/Backups/bramble/bramble-x.bramble");
	});

	it("mints an access token from the refresh token before the first call", async () => {
		const calls = route((url) => (url === TOKEN ? ok({ access_token: "MINTED" }) : ok()));
		const t = createDropboxTarget({ kind: "dropbox", refreshToken: "RT" });
		await t.put("bramble/x.bramble", bytesSource(new Uint8Array([9])));

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
		await t.put("bramble/x.bramble", bytesSource(new Uint8Array([1])));

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

		expect(JSON.parse(new TextDecoder().decode(calls[0]!.init.body as Uint8Array)).path).toBe(
			"/bramble",
		);
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

	// Dropbox caps a single upload call at 150 MB, so a larger backup goes as a session: the
	// file appears only at the commit, so a session cut off partway leaves nothing behind.
	it("uploads a large backup as a session and commits it to the right path", async () => {
		const calls = route((url) =>
			url.endsWith("/upload_session/start") ? ok({ session_id: "S1" }) : ok(),
		);
		const t = createDropboxTarget({ kind: "dropbox", refreshToken: "RT", accessToken: "AT" });
		const size = PART_SIZE + 9;
		await t.put("bramble/big.bramble", { size, read: async (_o, l) => new Uint8Array(l) });

		const steps = calls.map((c) => c.url.split("/").pop());
		expect(steps).toEqual(["start", "append_v2", "append_v2", "finish"]);
		const appends = calls.filter((c) => c.url.endsWith("/append_v2"));
		expect(appends.map((c) => argOf(c.init).cursor)).toEqual([
			{ session_id: "S1", offset: 0 },
			{ session_id: "S1", offset: PART_SIZE },
		]);
		const finish = argOf(calls[calls.length - 1]!.init);
		expect(finish.cursor).toEqual({ session_id: "S1", offset: size });
		expect(finish.commit).toEqual({ path: "/bramble/big.bramble", mode: "overwrite", mute: true });
	});

	it("fails the backup if any session step fails", async () => {
		route((url) =>
			url.endsWith("/upload_session/start")
				? ok({ session_id: "S1" })
				: url.endsWith("/append_v2")
					? status(500)
					: ok(),
		);
		const t = createDropboxTarget({ kind: "dropbox", refreshToken: "RT", accessToken: "AT" });
		await expect(
			t.put("bramble/big.bramble", { size: PART_SIZE, read: async (_o, l) => new Uint8Array(l) }),
		).rejects.toThrow(/append_v2 failed \(500/);
	});

	it("says what Dropbox said: its user_message first, else its error_summary tag", async () => {
		const t = createDropboxTarget({ kind: "dropbox", refreshToken: "RT", accessToken: "AT" });
		route(() =>
			status(409, {
				error_summary: "path/insufficient_space/..",
				user_message: { text: "Your Dropbox is full.", locale: "en" },
			}),
		);
		await expect(t.put("bramble/x.bramble", bytesSource(new Uint8Array([1])))).rejects.toThrow(
			"Dropbox upload failed (409: Your Dropbox is full.)",
		);
		route(() => status(409, { error_summary: "path/insufficient_space/..." }));
		await expect(t.put("bramble/x.bramble", bytesSource(new Uint8Array([1])))).rejects.toThrow(
			"Dropbox upload failed (409: path/insufficient_space)",
		);
		route(
			() => new Response('Error in call to API function "files/upload": bad arg', { status: 400 }),
		);
		await expect(t.put("bramble/x.bramble", bytesSource(new Uint8Array([1])))).rejects.toThrow(
			'Dropbox upload failed (400: Error in call to API function "files/upload": bad arg)',
		);
	});

	describe("rate limits", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());
		const limited = (retryAfter?: string) =>
			new Response(JSON.stringify({ error_summary: "too_many_write_operations/.." }), {
				status: 429,
				headers: retryAfter ? { "Retry-After": retryAfter } : {},
			});

		it("waits as long as Retry-After says, then sends the same upload again", async () => {
			let n = 0;
			const calls = route(() => (n++ === 0 ? limited("2") : ok()));
			const t = createDropboxTarget({ kind: "dropbox", refreshToken: "RT", accessToken: "AT" });
			const done = t.put("bramble/x.bramble", bytesSource(new Uint8Array([7])));
			await vi.advanceTimersByTimeAsync(1999);
			expect(calls).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			await expect(done).resolves.toBeUndefined();
			expect(calls).toHaveLength(2);
			expect(calls[1]!.init.body).toEqual(new Uint8Array([7]));
		});

		it("gives up after three retries and says why", async () => {
			const calls = route(() => limited());
			const t = createDropboxTarget({ kind: "dropbox", refreshToken: "RT", accessToken: "AT" });
			const done = expect(
				t.put("bramble/x.bramble", bytesSource(new Uint8Array([1]))),
			).rejects.toThrow("Dropbox upload failed (429: too_many_write_operations)");
			await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
			await done;
			expect(calls).toHaveLength(4);
		});

		it("leaves a long wait to the next run instead of holding this one open", async () => {
			const calls = route(() => limited("300"));
			const t = createDropboxTarget({ kind: "dropbox", refreshToken: "RT", accessToken: "AT" });
			await expect(t.put("bramble/x.bramble", bytesSource(new Uint8Array([1])))).rejects.toThrow(
				/429/,
			);
			expect(calls).toHaveLength(1);
		});
	});
});
