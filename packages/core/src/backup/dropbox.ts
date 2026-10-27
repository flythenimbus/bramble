import { fetchTransport, type HttpResponse, type HttpTransport } from "../adapters/http";
import { refreshAccessToken } from "./oauth";
import {
	type BackupObject,
	type BackupTarget,
	type BackupUpload,
	type DropboxConfig,
	PART_SIZE,
	readAll,
	responseText,
} from "./types";

interface Call {
	method: string;
	headers: Record<string, string>;
	body?: Uint8Array;
}

const json = <T>(res: HttpResponse): T => JSON.parse(responseText(res) || "{}") as T;

const CONTENT = "https://content.dropboxapi.com/2";
const API = "https://api.dropboxapi.com/2";

// A 429 waits out Retry-After (seconds), or backs off 1s, 2s, 4s without one. A wait past the cap
// is left to the next scheduled run rather than holding this one open.
const RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelayMs(res: HttpResponse, attempt: number): number {
	const seconds = Number(res.headers?.["retry-after"]);
	return seconds > 0 ? seconds * 1000 : 1000 * 2 ** attempt;
}

/** Dropbox's own account of a failure: user_message is meant for end users, error_summary is its tag. */
function failure(what: string, res: HttpResponse): Error {
	const text = responseText(res);
	let detail = text.trim().slice(0, 200);
	try {
		const body = JSON.parse(text) as {
			user_message?: { text?: unknown } | string;
			error_summary?: unknown;
		};
		const userText =
			typeof body.user_message === "string" ? body.user_message : body.user_message?.text;
		if (typeof userText === "string" && userText) detail = userText;
		// error_summary is padded with a random run of trailing dots; it is a prefix, not a value.
		else if (typeof body.error_summary === "string")
			detail = body.error_summary.replace(/[./]+$/, "");
	} catch {}
	return new Error(`Dropbox ${what} failed (${detail ? `${res.status}: ${detail}` : res.status})`);
}

/** Normalize an optional subfolder to a Dropbox path segment: "" or "/Sub/Folder". */
function folderPrefix(path?: string): string {
	const trimmed = (path ?? "").replace(/^\/+|\/+$/g, "");
	return trimmed ? `/${trimmed}` : "";
}

/**
 * A Dropbox BackupTarget over the HTTP content/RPC API. Auth is a bearer access
 * token minted from the stored refresh token: minted lazily and re-minted once on a
 * 401 (so an expired token self-heals). Object keys map to `<subfolder>/<key>` under
 * the connected app folder. See docs/cloud-storage-backups.md.
 *
 * `send` only carries the requests: the bearer token is added here. The extension passes one that
 * sends from its offscreen document, which no service-worker time limit cuts off mid-upload.
 */
export function createDropboxTarget(
	cfg: DropboxConfig,
	send: HttpTransport = fetchTransport,
): BackupTarget {
	const prefix = folderPrefix(cfg.path);
	let accessToken = cfg.accessToken ?? "";

	// Full Dropbox path for a backup key (keys already start with the prefix folder, e.g. "bramble/...").
	const fullPath = (key: string) => `${prefix}/${key.replace(/^\/+/, "")}`;

	async function token(): Promise<string> {
		if (!accessToken) accessToken = await refreshAccessToken("dropbox", cfg.refreshToken);
		return accessToken;
	}

	// Authorize + send; on a 401 drop the cached token and retry once with a fresh one.
	async function call(url: string, init: Call, retry = true, attempt = 0): Promise<HttpResponse> {
		const res = await send.send({
			method: init.method,
			url,
			body: init.body,
			headers: { ...init.headers, Authorization: `Bearer ${await token()}` },
		});
		if (res.status === 401 && retry) {
			accessToken = "";
			return call(url, init, false, attempt);
		}
		if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
			const wait = retryDelayMs(res, attempt);
			if (wait <= MAX_RETRY_WAIT_MS) {
				await sleep(wait);
				return call(url, init, retry, attempt + 1);
			}
		}
		return res;
	}

	/** One session step: the chunk goes in the body, its JSON argument in a header. */
	async function sessionCall(step: string, arg: unknown, chunk: Uint8Array): Promise<HttpResponse> {
		const res = await call(`${CONTENT}/files/upload_session/${step}`, {
			method: "POST",
			headers: {
				"Dropbox-API-Arg": JSON.stringify(arg),
				"Content-Type": "application/octet-stream",
			},
			body: chunk,
		});
		if (!res.ok) throw failure(`upload ${step}`, res);
		return res;
	}

	/**
	 * A backup too big for one upload call (Dropbox caps those at 150 MB), as an upload session:
	 * appended in parts, then committed. The file appears only at the commit, so a session cut
	 * off partway leaves nothing behind, and Dropbox expires the abandoned session itself.
	 */
	async function putInSession(key: string, body: BackupUpload) {
		const started = await sessionCall("start", { close: false }, new Uint8Array(0));
		const { session_id } = json<{ session_id: string }>(started);
		let offset = 0;
		while (offset < body.size) {
			const chunk = await body.read(offset, Math.min(PART_SIZE, body.size - offset));
			await sessionCall("append_v2", { cursor: { session_id, offset }, close: false }, chunk);
			offset += chunk.length;
		}
		await sessionCall(
			"finish",
			{
				cursor: { session_id, offset },
				commit: { path: fullPath(key), mode: "overwrite", mute: true },
			},
			new Uint8Array(0),
		);
	}

	return {
		async put(key, body, contentType) {
			if (body.size >= PART_SIZE) {
				await putInSession(key, body);
				return;
			}
			const arg = JSON.stringify({ path: fullPath(key), mode: "overwrite", mute: true });
			const res = await call(`${CONTENT}/files/upload`, {
				method: "POST",
				headers: {
					"Dropbox-API-Arg": arg,
					"Content-Type": contentType ?? "application/octet-stream",
				},
				body: await readAll(body),
			});
			if (!res.ok) throw failure("upload", res);
		},
		async get(key) {
			const res = await call(`${CONTENT}/files/download`, {
				method: "POST",
				headers: { "Dropbox-API-Arg": JSON.stringify({ path: fullPath(key) }) },
			});
			if (!res.ok) throw failure("download", res);
			return res.body;
		},
		async list(prefixArg) {
			// prefixArg is the object-key prefix with a trailing slash, e.g. "bramble/".
			const folder = `${prefix}/${prefixArg.replace(/\/+$/, "")}`;
			const res = await call(`${API}/files/list_folder`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: new TextEncoder().encode(
					JSON.stringify({ path: folder, recursive: false, limit: 2000 }),
				),
			});
			// 409 = path/not_found: the folder simply doesn't exist yet.
			if (res.status === 409) return [];
			if (!res.ok) throw failure("list", res);
			const listing = json<{
				entries?: { ".tag"?: string; name?: string; size?: number; server_modified?: string }[];
			}>(res);
			return (listing.entries ?? [])
				.filter((e) => e[".tag"] === "file" && e.name)
				.map(
					(e): BackupObject => ({
						key: `${prefixArg}${e.name}`,
						size: Number(e.size ?? 0),
						lastModified: e.server_modified,
					}),
				);
		},
		async remove(key) {
			const res = await call(`${API}/files/delete_v2`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: new TextEncoder().encode(JSON.stringify({ path: fullPath(key) })),
			});
			// 409 = path_lookup/not_found: already gone, which is fine (delete is idempotent).
			if (!res.ok && res.status !== 409) throw failure("delete", res);
		},
	};
}
