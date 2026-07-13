// AWS Signature Version 4 signing for S3-compatible backends. Uses WebCrypto,
// available in the extension service worker and the mobile webview, so there is
// no dependency on the Rust core. See docs/cloud-storage-backups.md.

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
	const bytes = typeof data === "string" ? encoder.encode(data) : data;
	const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
	return toHex(new Uint8Array(digest));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		new Uint8Array(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data)));
}

// AWS uri-encoding: unreserved chars (A-Za-z0-9-._~) pass through, everything
// else is percent-encoded. Path slashes are preserved when encodeSlash is false.
export function uriEncode(input: string, encodeSlash = true): string {
	let out = "";
	for (const ch of input) {
		if (/[A-Za-z0-9\-._~]/.test(ch)) {
			out += ch;
		} else if (ch === "/" && !encodeSlash) {
			out += "/";
		} else {
			for (const b of encoder.encode(ch))
				out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
		}
	}
	return out;
}

function canonicalQuery(params: URLSearchParams): string {
	const pairs = [...params].map(([k, v]) => [uriEncode(k), uriEncode(v)] as const);
	pairs.sort((a, b) =>
		a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
	);
	return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function amzDateNow(): string {
	// "2013-05-24T00:00:00.000Z" -> "20130524T000000Z"
	return new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export interface S3Credentials {
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
}

export interface SignInput {
	method: string;
	url: string;
	headers?: Record<string, string>; // extra headers to sign (e.g. content-type)
	body?: Uint8Array;
	credentials: S3Credentials;
	service?: string; // default "s3"
	amzDate?: string; // injectable for tests; otherwise the current time
}

/**
 * Sign an S3 request with SigV4. Returns the headers to attach to fetch(). Host
 * is part of the signature but omitted from the result, since the browser sets it.
 */
export async function signS3Request(
	input: SignInput,
): Promise<{ headers: Record<string, string> }> {
	const service = input.service ?? "s3";
	const url = new URL(input.url);
	const amzDate = input.amzDate ?? amzDateNow();
	const dateStamp = amzDate.slice(0, 8);
	const payloadHash = await sha256Hex(input.body ?? "");

	const signHeaders: Record<string, string> = {
		host: url.host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": amzDate,
	};
	for (const [k, v] of Object.entries(input.headers ?? {})) signHeaders[k.toLowerCase()] = v;

	const names = Object.keys(signHeaders).sort();
	// Each entry ends with "\n"; the join below adds one more before signedHeaders
	// to produce the blank line SigV4 requires after the headers block.
	const canonicalHeaders = names.map((n) => `${n}:${(signHeaders[n] ?? "").trim()}\n`).join("");
	const signedHeaders = names.join(";");

	const canonicalRequest = [
		input.method,
		uriEncode(url.pathname, false),
		canonicalQuery(url.searchParams),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join("\n");

	const scope = `${dateStamp}/${input.credentials.region}/${service}/aws4_request`;
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join(
		"\n",
	);

	const kDate = await hmac(encoder.encode(`AWS4${input.credentials.secretAccessKey}`), dateStamp);
	const kRegion = await hmac(kDate, input.credentials.region);
	const kService = await hmac(kRegion, service);
	const kSigning = await hmac(kService, "aws4_request");
	const signature = toHex(await hmac(kSigning, stringToSign));

	return {
		headers: {
			...(input.headers ?? {}),
			"x-amz-content-sha256": payloadHash,
			"x-amz-date": amzDate,
			Authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
		},
	};
}
