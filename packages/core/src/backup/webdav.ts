import { XMLParser } from "fast-xml-parser";
import type { BackupObject, BackupTarget, WebdavConfig } from "./types";

const xml = new XMLParser({ removeNSPrefix: true });

function joinUrl(a: string, b: string): string {
	const left = a.replace(/\/+$/, "");
	const right = b.replace(/^\/+/, "");
	return right ? `${left}/${right}` : `${left}/`;
}

// The server's own explanation for a failed request, appended to the thrown error.
// Sabre-based servers (Nextcloud, ownCloud) put it in <d:error><s:message>.
async function reason(res: Response): Promise<string> {
	try {
		const msg = xml.parse(await res.text())?.error?.message;
		return typeof msg === "string" && msg.trim() ? `: ${msg.trim()}` : "";
	} catch {
		return "";
	}
}

/** A WebDAV BackupTarget (Nextcloud, ownCloud, Fastmail, pCloud, Koofr, ...). */
export function createWebdavTarget(cfg: WebdavConfig): BackupTarget {
	const base = joinUrl(cfg.serverUrl, "");
	const basePath = new URL(base).pathname;
	const auth = `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`;
	const fileUrl = (key: string) => joinUrl(base, key);

	async function req(method: string, url: string, init?: RequestInit): Promise<Response> {
		const res = await fetch(url, {
			...init,
			method,
			// Never send ambient cookies: a browser session for the same host (e.g. the
			// Nextcloud web UI in another tab) outranks our Basic header server-side and
			// then fails the server's CSRF check, turning valid credentials into a 401.
			credentials: "omit",
			headers: { Authorization: auth, ...(init?.headers as Record<string, string>) },
		});
		if (!res.ok) throw new Error(`WebDAV ${method} failed (${res.status})${await reason(res)}`);
		return res;
	}

	// Best-effort MKCOL of the collections holding this key, outermost first: MKCOL
	// does not create intermediates, and the key prefix is now the user's own folder,
	// which may be nested. A failure (e.g. it already exists) is ignored and the PUT
	// surfaces any real problem.
	async function ensureParent(key: string): Promise<void> {
		const segs = key.split("/").filter(Boolean).slice(0, -1);
		for (let i = 1; i <= segs.length; i++) {
			try {
				await fetch(joinUrl(base, segs.slice(0, i).join("/")), {
					method: "MKCOL",
					credentials: "omit",
					headers: { Authorization: auth },
				});
			} catch {}
		}
	}

	// Turn a PROPFIND href into a key relative to base, so it round-trips with put/remove.
	function hrefToKey(href: string): string {
		let path = href;
		try {
			path = new URL(href, base).pathname;
		} catch {}
		if (path.startsWith(basePath)) path = path.slice(basePath.length);
		return decodeURIComponent(path.replace(/^\/+/, ""));
	}

	return {
		async put(key, body, contentType) {
			await ensureParent(key);
			await req("PUT", fileUrl(key), {
				body: body as BodyInit,
				headers: contentType ? { "Content-Type": contentType } : undefined,
			});
		},
		async get(key) {
			const res = await req("GET", fileUrl(key));
			return new Uint8Array(await res.arrayBuffer());
		},
		async list(prefix) {
			const res = await req("PROPFIND", joinUrl(base, prefix), { headers: { Depth: "1" } });
			const doc = xml.parse(await res.text());
			const responses = doc?.multistatus?.response;
			const arr = Array.isArray(responses) ? responses : responses ? [responses] : [];
			const out: BackupObject[] = [];
			for (const r of arr) {
				const prop = r?.propstat?.prop ?? r?.propstat?.[0]?.prop;
				const len = prop?.getcontentlength;
				const key = hrefToKey(r?.href ?? "");
				// Skip collections (no content length) and the listed folder itself.
				if (len === undefined || !key) continue;
				out.push({ key, size: Number(len), lastModified: prop?.getlastmodified });
			}
			return out;
		},
		async remove(key) {
			await req("DELETE", fileUrl(key));
		},
	};
}
