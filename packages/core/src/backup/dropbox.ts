import { refreshAccessToken } from "./oauth";
import type { BackupObject, BackupTarget, DropboxConfig } from "./types";

const CONTENT = "https://content.dropboxapi.com/2";
const API = "https://api.dropboxapi.com/2";

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
 */
export function createDropboxTarget(cfg: DropboxConfig): BackupTarget {
	const prefix = folderPrefix(cfg.path);
	let accessToken = cfg.accessToken ?? "";

	// Full Dropbox path for a backup key (keys already start with the prefix folder, e.g. "bramble/...").
	const fullPath = (key: string) => `${prefix}/${key.replace(/^\/+/, "")}`;

	async function token(): Promise<string> {
		if (!accessToken) accessToken = await refreshAccessToken("dropbox", cfg.refreshToken);
		return accessToken;
	}

	// Authorize + send; on a 401 drop the cached token and retry once with a fresh one.
	async function call(url: string, init: RequestInit, retry = true): Promise<Response> {
		const res = await fetch(url, {
			...init,
			headers: {
				...(init.headers as Record<string, string>),
				Authorization: `Bearer ${await token()}`,
			},
		});
		if (res.status === 401 && retry) {
			accessToken = "";
			return call(url, init, false);
		}
		return res;
	}

	return {
		async put(key, body, contentType) {
			const arg = JSON.stringify({ path: fullPath(key), mode: "overwrite", mute: true });
			const res = await call(`${CONTENT}/files/upload`, {
				method: "POST",
				headers: {
					"Dropbox-API-Arg": arg,
					"Content-Type": contentType ?? "application/octet-stream",
				},
				body: body as BodyInit,
			});
			if (!res.ok) throw new Error(`Dropbox upload failed (${res.status})`);
		},
		async get(key) {
			const res = await call(`${CONTENT}/files/download`, {
				method: "POST",
				headers: { "Dropbox-API-Arg": JSON.stringify({ path: fullPath(key) }) },
			});
			if (!res.ok) throw new Error(`Dropbox download failed (${res.status})`);
			return new Uint8Array(await res.arrayBuffer());
		},
		async list(prefixArg) {
			// prefixArg is the object-key prefix with a trailing slash, e.g. "bramble/".
			const folder = `${prefix}/${prefixArg.replace(/\/+$/, "")}`;
			const res = await call(`${API}/files/list_folder`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: folder, recursive: false, limit: 2000 }),
			});
			// 409 = path/not_found: the folder simply doesn't exist yet.
			if (res.status === 409) return [];
			if (!res.ok) throw new Error(`Dropbox list failed (${res.status})`);
			const json = (await res.json()) as {
				entries?: { ".tag"?: string; name?: string; size?: number; server_modified?: string }[];
			};
			return (json.entries ?? [])
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
				body: JSON.stringify({ path: fullPath(key) }),
			});
			// 409 = path_lookup/not_found: already gone, which is fine (delete is idempotent).
			if (!res.ok && res.status !== 409) throw new Error(`Dropbox delete failed (${res.status})`);
		},
	};
}
