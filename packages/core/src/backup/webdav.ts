import { XMLParser } from "fast-xml-parser";
import type { BackupObject, BackupTarget, WebdavConfig } from "./types";

const xml = new XMLParser({ removeNSPrefix: true });

function joinUrl(a: string, b: string): string {
	const left = a.replace(/\/+$/, "");
	const right = b.replace(/^\/+/, "");
	return right ? `${left}/${right}` : `${left}/`;
}

/** A WebDAV BackupTarget (Nextcloud, ownCloud, Fastmail, pCloud, Koofr, ...). */
export function createWebdavTarget(cfg: WebdavConfig): BackupTarget {
	const base = joinUrl(cfg.serverUrl, cfg.path ?? "");
	const basePath = new URL(base).pathname;
	const auth = `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`;
	const fileUrl = (key: string) => joinUrl(base, key);

	async function req(method: string, url: string, init?: RequestInit): Promise<Response> {
		const res = await fetch(url, {
			...init,
			method,
			headers: { Authorization: auth, ...(init?.headers as Record<string, string>) },
		});
		if (!res.ok) throw new Error(`WebDAV ${method} failed (${res.status})`);
		return res;
	}

	// Best-effort MKCOL of the collection holding this key; a failure (e.g. it
	// already exists) is ignored and the PUT surfaces any real problem.
	async function ensureParent(key: string): Promise<void> {
		const slash = key.lastIndexOf("/");
		if (slash < 0) return;
		try {
			await fetch(joinUrl(base, key.slice(0, slash)), {
				method: "MKCOL",
				headers: { Authorization: auth },
			});
		} catch {}
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
