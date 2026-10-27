import { XMLParser } from "fast-xml-parser";
import { fetchTransport, type HttpRequest, type HttpTransport } from "../adapters/http";
import { uploadTempKey } from "./orchestrator";
import {
	type BackupHttpResponse,
	type BackupObject,
	type BackupTarget,
	type BackupTransport,
	PART_SIZE,
	readAll,
	responseText,
	type WebdavConfig,
} from "./types";

const xml = new XMLParser({ removeNSPrefix: true });

function joinUrl(a: string, b: string): string {
	const left = a.replace(/\/+$/, "");
	const right = b.replace(/^\/+/, "");
	return right ? `${left}/${right}` : `${left}/`;
}

// The server's own explanation for a failed request, appended to the thrown error.
// Sabre-based servers (Nextcloud, ownCloud) put it in <d:error><s:message>.
function reason(res: BackupHttpResponse): string {
	// Nextcloud throttles an account after repeated failed sign-ins, so a 429 outlives
	// the bad credentials that caused it: correcting them still fails until it expires.
	if (res.status === 429)
		return ": rate-limited by the server, which throttles after failed sign-ins. Check the address and credentials, then wait a few minutes and retry";
	try {
		const msg = xml.parse(responseText(res))?.error?.message;
		return typeof msg === "string" && msg.trim() ? `: ${msg.trim()}` : "";
	} catch {
		return "";
	}
}

/**
 * Authenticate with the config's credentials here, then hand the request to `send`.
 *
 * Who authenticates and who sends are separate questions. The extension does both in JS; mobile
 * authenticates here and sends over its native transport, because no WebDAV server grants CORS
 * to a webview origin; the desktop replaces this whole transport with one that does both in
 * Rust, where the credentials live. See BackupTransport and @core/adapters/http.
 */
export function webdavSigningTransport(
	cfg: WebdavConfig,
	send: HttpTransport = fetchTransport,
): BackupTransport {
	const auth = `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`;
	return {
		// Ambient cookies are never sent, which every sender guarantees: a browser session for the
		// same host (e.g. the Nextcloud web UI in another tab) outranks our Basic header
		// server-side and then fails the server's CSRF check, turning valid credentials into a
		// 401. That cost a day once (1255ab7b), which is why the rule lives in the transport.
		send: ({ method, url, headers, body }) =>
			send.send({ method, url, headers: { Authorization: auth, ...headers }, body }),
	};
}

/** A WebDAV BackupTarget (Nextcloud, ownCloud, Fastmail, pCloud, Koofr, ...). */
export function createWebdavTarget(
	cfg: WebdavConfig,
	transport: BackupTransport = webdavSigningTransport(cfg),
): BackupTarget {
	const base = joinUrl(cfg.serverUrl, "");
	const basePath = new URL(base).pathname;
	const fileUrl = (key: string) => joinUrl(base, key);

	async function req(
		method: string,
		url: string,
		init: { body?: HttpRequest["body"]; headers?: Record<string, string> } = {},
	): Promise<BackupHttpResponse> {
		const res = await transport.send({ method, url, ...init });
		if (!res.ok) throw new Error(`WebDAV ${method} failed (${res.status})${reason(res)}`);
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
				await transport.send({
					method: "MKCOL",
					url: joinUrl(base, segs.slice(0, i).join("/")),
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
			// Written aside and moved into place, because many servers write a PUT in place: an upload
			// cut off partway would leave a truncated file under a real snapshot name, counted by the
			// prune and only found out at restore. A MOVE within one server is atomic.
			const temp = uploadTempKey(key);
			try {
				// WebDAV has no standard way to upload in parts, so a large backup goes as one request
				// whose body the transport reads on demand instead of holding.
				await req("PUT", fileUrl(temp), {
					body: body.size < PART_SIZE ? await readAll(body) : body,
					headers: contentType ? { "Content-Type": contentType } : undefined,
				});
				// What the server kept, before it gets a snapshot's name: a server that took a short
				// body without complaint must not turn it into a backup that only fails at restore.
				const stored = await req("PROPFIND", fileUrl(temp), { headers: { Depth: "0" } });
				const response = xml.parse(responseText(stored))?.multistatus?.response;
				const propstats = [response?.propstat ?? []].flat();
				const length = Number(
					propstats.find(
						(p: { prop?: { getcontentlength?: unknown } }) =>
							p?.prop?.getcontentlength !== undefined,
					)?.prop?.getcontentlength,
				);
				if (length !== body.size) {
					throw new Error(`WebDAV stored ${length} bytes of a ${body.size}-byte backup`);
				}
				await req("MOVE", fileUrl(temp), {
					headers: { Destination: fileUrl(key), Overwrite: "T" },
				});
			} catch (e) {
				// Best effort; a later run's prune sweeps whatever survives this.
				await transport.send({ method: "DELETE", url: fileUrl(temp) }).catch(() => {});
				throw e;
			}
		},
		async get(key) {
			return (await req("GET", fileUrl(key))).body;
		},
		async list(prefix) {
			const res = await req("PROPFIND", joinUrl(base, prefix), { headers: { Depth: "1" } });
			const doc = xml.parse(responseText(res));
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
