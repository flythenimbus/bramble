import { XMLParser } from "fast-xml-parser";
import { signS3Request } from "./sigv4";
import type { BackupObject, BackupTarget, S3Config } from "./types";

const xml = new XMLParser();

/** An S3-compatible BackupTarget (Backblaze B2, R2, Storj, Wasabi, MinIO, ...). */
export function createS3Target(cfg: S3Config): BackupTarget {
	const base = cfg.endpoint.replace(/\/+$/, "");
	const creds = {
		accessKeyId: cfg.accessKeyId,
		secretAccessKey: cfg.secretAccessKey,
		region: cfg.region,
	};
	const objectUrl = (key: string) => `${base}/${cfg.bucket}/${key}`;

	async function send(
		method: string,
		url: string,
		body?: Uint8Array,
		contentType?: string,
	): Promise<Response> {
		const { headers } = await signS3Request({
			method,
			url,
			body,
			headers: contentType ? { "content-type": contentType } : undefined,
			credentials: creds,
		});
		const res = await fetch(url, { method, body: body as BodyInit | undefined, headers });
		if (!res.ok) throw new Error(`S3 ${method} failed (${res.status})`);
		return res;
	}

	return {
		async put(key, body, contentType) {
			await send("PUT", objectUrl(key), body, contentType ?? "application/octet-stream");
		},
		async get(key) {
			const res = await send("GET", objectUrl(key));
			return new Uint8Array(await res.arrayBuffer());
		},
		async list(prefix) {
			// Single page (up to 1000 keys), ample for keep-last-N retention.
			const url = `${base}/${cfg.bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
			const doc = xml.parse(await (await send("GET", url)).text());
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
