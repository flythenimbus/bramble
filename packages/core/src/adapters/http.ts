/**
 * How an outbound request actually reaches the network on this platform.
 *
 * Absent from a `Platform` means the webview can simply `fetch`, which is the extension (a
 * background worker holding `<all_urls>` bypasses CORS) and the dev browser. The desktop and
 * mobile provide one, because their webviews cannot reach an arbitrary provider at all: no S3
 * endpoint, WebDAV server, or CORS-less API grants anything to `tauri://localhost` or
 * `capacitor://localhost`.
 *
 * Two rules hold in every implementation, the native ones included, and they are why this is an
 * interface rather than a per-platform `fetch` wrapper:
 *
 * - **No ambient cookies.** The only credential is the header the caller set. A browser session
 *   for the same host has already outranked an `Authorization` header here once (1255ab7b, where
 *   an open Nextcloud tab made correct WebDAV credentials surface as a 401).
 * - **No redirect following.** A redirect out of an API call means the session was rejected and
 *   the destination is an HTML login page with no CORS, so chasing it turns a clean "bad key"
 *   into an opaque failure. A 3xx comes back as itself.
 *
 * See docs/email-aliases.md and docs/cloud-storage-backups.md.
 */
export interface HttpTransport {
	send(req: HttpRequest): Promise<HttpResponse>;
}

/**
 * What a transport throws when the platform stopped the request itself, rather than the network
 * or the server failing it: iOS ran out of the background time it gives an app that was left.
 * Nothing is wrong with the destination, so callers treat it as "try again", never as a failure
 * to back off from.
 */
export const TRANSFER_INTERRUPTED = "transfer/interrupted";

export interface HttpRequest {
	method: string;
	url: string;
	headers?: Record<string, string>;
	/** Bytes in hand, or a body too large to hold, read on demand (see HttpBodySource). */
	body?: Uint8Array | HttpBodySource;
}

/**
 * A request body read on demand, for the one request that cannot be split: a WebDAV PUT of a
 * large backup (WebDAV has no standard way to upload in parts). Every transport must send one
 * whole without holding it, each in its own way: the browser builds a Blob a piece at a time,
 * the desktop streams it through Rust, mobile spools it to a file the native side sends.
 */
export interface HttpBodySource {
	size: number;
	read(offset: number, length: number): Promise<Uint8Array>;
	/** Where the bytes already sit on this device, when they do (an export a native core wrote):
	 * a shell can then hand the file on rather than copy it back through the webview. */
	path?: string;
}

/** How much of a body source is read at a time. */
const BODY_CHUNK = 4 * 1024 * 1024;

/** Assemble a body source into a Blob, one chunk at a time. Each chunk becomes a Blob of its own
 * before the next is read, so the browser holds the bytes and this script holds one chunk. */
export async function bodyToBlob(body: HttpBodySource): Promise<Blob> {
	const parts: Blob[] = [];
	for (let at = 0; at < body.size; at += BODY_CHUNK) {
		parts.push(new Blob([(await body.read(at, Math.min(BODY_CHUNK, body.size - at))) as BlobPart]));
	}
	return new Blob(parts);
}

/** Body arrives whole: these are API replies and vault blobs, never a stream. */
export interface HttpResponse {
	status: number;
	ok: boolean;
	body: Uint8Array;
	/** Response headers, names lower-cased, where the transport carries them. */
	headers?: Record<string, string>;
}

/**
 * The default, for platforms that can reach a provider from the process they run in.
 *
 * `redirect: "manual"` surfaces a redirect as an opaque response with status 0 rather than a
 * 3xx, so callers distinguishing the two should treat 0 as a redirect as well. A native
 * transport, having no opaque responses, returns the real status instead.
 */
export const fetchTransport: HttpTransport = {
	async send({ method, url, headers, body }) {
		const res = await fetch(url, {
			method,
			headers,
			body: (body && !(body instanceof Uint8Array) ? await bodyToBlob(body) : body) as
				| BodyInit
				| undefined,
			credentials: "omit",
			redirect: "manual",
		});
		return {
			status: res.status,
			ok: res.ok,
			body: new Uint8Array(await res.arrayBuffer()),
			headers: Object.fromEntries(res.headers),
		};
	},
};
