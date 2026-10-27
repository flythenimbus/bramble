import { XMLParser } from "fast-xml-parser";
import { fetchTransport, type HttpTransport } from "../adapters/http";
import { STALE_UPLOAD_MS } from "./orchestrator";
import { signS3Request } from "./sigv4";
import {
	type BackupObject,
	type BackupTarget,
	type BackupTransport,
	type BackupUpload,
	PART_SIZE,
	readAll,
	responseText,
	type S3Config,
} from "./types";

const xml = new XMLParser();
// Multipart replies carry upload ids and ETags, which must go back exactly as they came: a parser
// that turns a numeric-looking id into a number has already lost it.
const xmlRaw = new XMLParser({ parseTagValue: false });

/** S3 allows at most this many parts, so a very large backup gets larger parts. */
const MAX_PARTS = 10_000;
const MIB = 1024 * 1024;

const asArray = <T>(v: T | T[] | undefined): T[] => (Array.isArray(v) ? v : v ? [v] : []);

function xmlEscape(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A value from a multipart reply, as the server meant it. The parser decodes the five named
 * entities but not character references, and servers use those: MinIO sends an ETag's quotes as
 * `&#34;`, which escaped again on the way back is an ETag no part matches.
 */
function xmlText(v: unknown): string {
	return String(v ?? "")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
			String.fromCodePoint(Number.parseInt(hex, 16)),
		)
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)));
}

/**
 * Sign with the config's credentials here, then hand the request to `send`.
 *
 * Who signs and who sends are separate questions, and the platforms answer them differently.
 * The extension does both in JS. Mobile signs here and sends over its native transport, because
 * no S3 endpoint grants CORS to a webview origin but the credentials are already in hand. The
 * desktop does neither here: it replaces this whole transport with one that signs and sends in
 * Rust, where the credentials live. See BackupTransport and @core/adapters/http.
 */
export function s3SigningTransport(
	cfg: S3Config,
	send: HttpTransport = fetchTransport,
): BackupTransport {
	const credentials = {
		accessKeyId: cfg.accessKeyId,
		secretAccessKey: cfg.secretAccessKey,
		region: cfg.region,
	};
	return {
		async send({ method, url, headers, body }) {
			// Every S3 body is one part, whole in memory (see createS3Target), which is what lets its
			// hash go into the signature.
			if (body && !(body instanceof Uint8Array)) throw new Error("S3 uploads go up in parts");
			const signed = await signS3Request({ method, url, body, headers, credentials });
			// The sender omits ambient cookies for the same reason as WebDAV: a self-hosted
			// endpoint (MinIO, Garage) may sit behind a cookie session that outranks our signature.
			return send.send({ method, url, headers: signed.headers, body });
		},
	};
}

/** An S3-compatible BackupTarget (Backblaze B2, R2, Storj, Wasabi, MinIO, ...). */
export function createS3Target(
	cfg: S3Config,
	transport: BackupTransport = s3SigningTransport(cfg),
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

	/** Every part an upload holds, from the server's own record of it. */
	async function listParts(key: string, uploadId: string) {
		const parts: { number: number; etag: string; size: number }[] = [];
		let marker = "";
		for (;;) {
			const url = `${objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}${
				marker ? `&part-number-marker=${encodeURIComponent(marker)}` : ""
			}`;
			const doc = xmlRaw.parse(responseText(await send("GET", url)))?.ListPartsResult;
			for (const p of asArray<{ PartNumber: string; ETag: string; Size: string }>(doc?.Part)) {
				parts.push({ number: Number(p.PartNumber), etag: xmlText(p.ETag), size: Number(p.Size) });
			}
			marker = String(doc?.NextPartNumberMarker ?? "");
			if (String(doc?.IsTruncated) !== "true" || !marker) return parts;
		}
	}

	/**
	 * A backup too big for one request, in parts. The object exists only once the upload is
	 * completed, which makes this as atomic as a single PUT: a run cut off partway leaves no
	 * snapshot behind, only parts that `sweepIncomplete` later abandons.
	 *
	 * The ETags the completion needs are read back with ListParts rather than from each part's
	 * response headers, which the transports do not return. Checking that list against what was
	 * sent also catches a part the server lost before anything is committed.
	 */
	async function putInParts(key: string, body: BackupUpload, contentType: string) {
		const created = await send("POST", `${objectUrl(key)}?uploads`, undefined, contentType);
		const uploadId = xmlText(
			xmlRaw.parse(responseText(created))?.InitiateMultipartUploadResult?.UploadId,
		);
		if (!uploadId) throw new Error("S3 did not start a multipart upload");
		const q = `uploadId=${encodeURIComponent(uploadId)}`;
		try {
			const partSize = Math.max(PART_SIZE, Math.ceil(body.size / MAX_PARTS / MIB) * MIB);
			const sent: { number: number; size: number }[] = [];
			for (let at = 0, n = 1; at < body.size; at += partSize, n++) {
				const bytes = await body.read(at, Math.min(partSize, body.size - at));
				await send("PUT", `${objectUrl(key)}?partNumber=${n}&${q}`, bytes);
				sent.push({ number: n, size: bytes.length });
			}
			const held = await listParts(key, uploadId);
			const whole =
				held.length === sent.length &&
				sent.every((p, i) => held[i]?.number === p.number && held[i]?.size === p.size);
			if (!whole) throw new Error("S3 does not hold every part that was uploaded");
			const manifest = `<CompleteMultipartUpload>${held
				.map(
					(p) =>
						`<Part><PartNumber>${p.number}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`,
				)
				.join("")}</CompleteMultipartUpload>`;
			const done = await send(
				"POST",
				`${objectUrl(key)}?${q}`,
				new TextEncoder().encode(manifest),
				"application/xml",
			);
			// S3 can answer a completion 200 OK and still have failed it, with an <Error> body.
			if (xmlRaw.parse(responseText(done))?.Error) {
				throw new Error("S3 failed to complete the upload");
			}
		} catch (e) {
			// Best effort; sweepIncomplete gets whatever this misses.
			await transport.send({ method: "DELETE", url: `${objectUrl(key)}?${q}` }).catch(() => {});
			throw e;
		}
	}

	return {
		async put(key, body, contentType) {
			const type = contentType ?? "application/octet-stream";
			if (body.size < PART_SIZE) await send("PUT", objectUrl(key), await readAll(body), type);
			else await putInParts(key, body, type);
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
		async sweepIncomplete(prefix, now, own) {
			const url = `${base}/${cfg.bucket}?uploads&prefix=${encodeURIComponent(prefix)}`;
			const doc = xmlRaw.parse(responseText(await send("GET", url)))?.ListMultipartUploadsResult;
			for (const u of asArray<{ Key: string; UploadId: string; Initiated?: string }>(doc?.Upload)) {
				const started = Date.parse(String(u.Initiated ?? ""));
				// Undated or recent: possibly another device's upload, still in flight.
				if (!Number.isFinite(started) || now.getTime() - started <= STALE_UPLOAD_MS) continue;
				const key = xmlText(u.Key);
				if (!own(key)) continue;
				await transport
					.send({
						method: "DELETE",
						url: `${objectUrl(key)}?uploadId=${encodeURIComponent(xmlText(u.UploadId))}`,
					})
					.catch(() => {});
			}
		},
	};
}
