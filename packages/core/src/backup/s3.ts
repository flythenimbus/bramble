import { XMLParser } from "fast-xml-parser";
import { signS3Request } from "./sigv4";
import {
	type BackupObject,
	type BackupTarget,
	type BackupTransport,
	responseText,
	type S3Config,
} from "./types";

const xml = new XMLParser();

/**
 * The default transport: sign with the config's credentials here, then `fetch`. The desktop
 * replaces it with one that signs and sends in Rust, where the credentials live and where the
 * request is not subject to the webview's CORS. See BackupTransport.
 */
function webTransport(cfg: S3Config): BackupTransport {
	const credentials = {
		accessKeyId: cfg.accessKeyId,
		secretAccessKey: cfg.secretAccessKey,
		region: cfg.region,
	};
	return {
		async send({ method, url, headers, body }) {
			const signed = await signS3Request({ method, url, body, headers, credentials });
			// credentials: "omit" for the same reason as WebDAV: a self-hosted endpoint
			// (MinIO, Garage) may sit behind a cookie session that outranks our signature.
			const res = await fetch(url, {
				method,
				body: body as BodyInit | undefined,
				headers: signed.headers,
				credentials: "omit",
			});
			return {
				status: res.status,
				ok: res.ok,
				body: new Uint8Array(await res.arrayBuffer()),
			};
		},
	};
}

/** An S3-compatible BackupTarget (Backblaze B2, R2, Storj, Wasabi, MinIO, ...). */
export function createS3Target(
	cfg: S3Config,
	transport: BackupTransport = webTransport(cfg),
): BackupTarget {
	const base = cfg.endpoint.replace(/\/+$/, "");
	const objectUrl = (key: string) => `${base}/${cfg.bucket}/${key}`;

	async function send(method: string, url: string, body?: Uint8Array, contentType?: string) {
		const res = await transport.send({
			method,
			url,
			body,
			headers: contentType ? { "content-type": contentType } : undefined,
		});
		if (!res.ok) throw new Error(`S3 ${method} failed (${res.status})`);
		return res;
	}

	return {
		async put(key, body, contentType) {
			await send("PUT", objectUrl(key), body, contentType ?? "application/octet-stream");
		},
		async get(key) {
			return (await send("GET", objectUrl(key))).body;
		},
		async list(prefix) {
			// Single page (up to 1000 keys), ample for keep-last-N retention.
			const url = `${base}/${cfg.bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
			const doc = xml.parse(responseText(await send("GET", url)));
			const raw = doc?.ListBucketResult?.Contents;
			const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
			return items.map(
				(c: { Key: string; Size: number; LastModified?: string }): BackupObject => ({
					key: String(c.Key),
					size: Number(c.Size),
					lastModified: c.LastModified,
				}),
			);
		},
		async remove(key) {
			await send("DELETE", objectUrl(key));
		},
	};
}
