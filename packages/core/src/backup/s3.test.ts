import { afterEach, describe, expect, it, vi } from "vitest";
import { STALE_UPLOAD_MS } from "./orchestrator";
import { createS3Target } from "./s3";
import { type BackupHttpRequest, type BackupTransport, PART_SIZE, type S3Config } from "./types";
import { bytesSource } from "./zip";

const CFG: S3Config = {
	kind: "s3",
	endpoint: "https://s3.us-west-002.backblazeb2.com",
	region: "us-west-002",
	bucket: "mybucket",
	accessKeyId: "AKIAIOSFODNN7EXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

afterEach(() => vi.unstubAllGlobals());

/** A transport that records what it was asked to send and answers with `body`. */
function recorder(body = "", status = 200) {
	const sent: BackupHttpRequest[] = [];
	const transport: BackupTransport = {
		async send(req) {
			sent.push(req);
			return { status, ok: status < 300, body: new TextEncoder().encode(body) };
		},
	};
	return { transport, sent };
}

const LISTING = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Contents><Key>bramble/bramble-20260814T101112Z-abcd1234.bramble</Key><Size>42</Size></Contents></ListBucketResult>`;

describe("createS3Target with an injected transport", () => {
	// The desktop's transport authenticates in the Rust shell, where the credential lives. If any
	// of these requests carried an Authorization header, the secret would have been in JS to build
	// it, which is exactly what that arrangement exists to avoid.
	it("hands the transport an unauthenticated request and never calls fetch", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const { transport, sent } = recorder(LISTING);
		const target = createS3Target(CFG, transport);

		await target.put(
			"bramble/x.bramble",
			bytesSource(new Uint8Array([1, 2, 3])),
			"application/octet-stream",
		);
		await target.list("bramble/");
		await target.remove("bramble/x.bramble");

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(sent.map((r) => r.method)).toEqual(["PUT", "GET", "DELETE"]);
		for (const req of sent) {
			const names = Object.keys(req.headers ?? {}).map((h) => h.toLowerCase());
			expect(names).not.toContain("authorization");
			expect(names).not.toContain("x-amz-date");
		}
	});

	it("still builds the object URLs and parses the listing", async () => {
		const { transport, sent } = recorder(LISTING);
		const objects = await createS3Target(CFG, transport).list("bramble/");
		expect(sent[0]?.url).toBe(
			"https://s3.us-west-002.backblazeb2.com/mybucket?list-type=2&prefix=bramble%2F",
		);
		expect(objects).toEqual([
			{
				key: "bramble/bramble-20260814T101112Z-abcd1234.bramble",
				size: 42,
				lastModified: undefined,
			},
		]);
	});

	it("surfaces a failed status as an error", async () => {
		const { transport } = recorder("denied", 403);
		await expect(createS3Target(CFG, transport).get("bramble/x")).rejects.toThrow(/403/);
	});

	// Without a transport nothing changes for the extension and mobile: sign here, then fetch.
	it("defaults to signing in JS and calling fetch", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL, init?: RequestInit) => {
				calls.push({ url: String(url), init: init ?? {} });
				return new Response(new Uint8Array(), { status: 200 });
			}),
		);
		await createS3Target(CFG).remove("bramble/x.bramble");
		const headers = calls[0]?.init.headers as Record<string, string>;
		expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//);
		expect(calls[0]?.init.credentials).toBe("omit");
	});
});

/**
 * Just enough of S3's multipart API, in memory: what the provider must get right is the
 * sequence and the bookkeeping, and a fake that assembles the object shows both.
 */
function fakeS3(opts: { dropPart?: number; failComplete?: boolean; uploadId?: string } = {}) {
	const objects = new Map<string, Uint8Array>();
	const uploads = new Map<
		string,
		{ key: string; parts: Map<number, Uint8Array>; initiated: string }
	>();
	const sent: BackupHttpRequest[] = [];
	const largest = { body: 0 };
	const completions: string[] = [];
	const ok = (text = "") => ({ status: 200, ok: true, body: new TextEncoder().encode(text) });
	const transport: BackupTransport = {
		async send(req) {
			sent.push(req);
			const body = req.body instanceof Uint8Array ? req.body : undefined;
			largest.body = Math.max(largest.body, body?.length ?? 0);
			const url = new URL(req.url);
			const key = decodeURIComponent(url.pathname.replace(/^\/mybucket\/?/, ""));
			const q = url.searchParams;
			if (req.method === "POST" && q.has("uploads")) {
				const id = opts.uploadId ?? `up-${uploads.size + 1}`;
				uploads.set(id, { key, parts: new Map(), initiated: new Date().toISOString() });
				return ok(
					`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
				);
			}
			const upload = uploads.get(q.get("uploadId") ?? "");
			if (req.method === "PUT" && q.has("partNumber")) {
				const n = Number(q.get("partNumber"));
				if (n !== opts.dropPart) upload?.parts.set(n, body ?? new Uint8Array());
				return ok();
			}
			if (req.method === "GET" && upload) {
				const parts = [...upload.parts.entries()].sort((a, b) => a[0] - b[0]);
				return ok(
					`<ListPartsResult><IsTruncated>false</IsTruncated>${parts
						.map(
							([n, b]) =>
								`<Part><PartNumber>${n}</PartNumber><ETag>&#34;etag-${n}&#34;</ETag><Size>${b.length}</Size></Part>`,
						)
						.join("")}</ListPartsResult>`,
				);
			}
			if (req.method === "POST" && upload) {
				completions.push(new TextDecoder().decode(body));
				if (opts.failComplete) return ok("<Error><Code>InternalError</Code></Error>");
				const parts = [...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
				const whole = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
				let at = 0;
				for (const b of parts) {
					whole.set(b, at);
					at += b.length;
				}
				objects.set(upload.key, whole);
				uploads.delete(q.get("uploadId") ?? "");
				return ok("<CompleteMultipartUploadResult/>");
			}
			if (req.method === "DELETE" && q.has("uploadId")) {
				uploads.delete(q.get("uploadId") ?? "");
				return { status: 204, ok: true, body: new Uint8Array() };
			}
			if (req.method === "GET" && q.has("uploads")) {
				return ok(
					`<ListMultipartUploadsResult>${[...uploads.entries()]
						.map(
							([id, u]) =>
								`<Upload><Key>${u.key}</Key><UploadId>${id}</UploadId><Initiated>${u.initiated}</Initiated></Upload>`,
						)
						.join("")}</ListMultipartUploadsResult>`,
				);
			}
			if (req.method === "PUT") {
				objects.set(key, body ?? new Uint8Array());
				return ok();
			}
			return ok();
		},
	};
	return { transport, sent, objects, uploads, largest, completions };
}

const patterned = (size: number) => ({
	size,
	read: async (offset: number, length: number) =>
		Uint8Array.from({ length }, (_, i) => (offset + i) % 251),
});

describe("S3 multipart, for a backup too big for one request", () => {
	it("uploads in parts, never one request holding the whole backup, and completes it", async () => {
		const s3 = fakeS3();
		const size = 2 * PART_SIZE + 5;
		await createS3Target(CFG, s3.transport).put("bramble/big.bramble", patterned(size));
		const object = s3.objects.get("bramble/big.bramble");
		expect(object?.length).toBe(size);
		expect(object?.[PART_SIZE + 7]).toBe((PART_SIZE + 7) % 251);
		expect(s3.largest.body).toBeLessThanOrEqual(PART_SIZE);
		expect(s3.sent.filter((r) => r.url.includes("partNumber=")).length).toBe(3);
		expect(s3.uploads.size).toBe(0);
		// The fake answers ETags as MinIO does, quotes as `&#34;`: they must go back as the quotes.
		expect(s3.completions[0]).toContain('<ETag>"etag-1"</ETag>');
	});

	// The ETags come back from ListParts, so its answer is also a check: a part the server does
	// not hold must stop the completion, not produce an object with a hole in it.
	it("abandons the upload, and writes nothing, when the server lost a part", async () => {
		const s3 = fakeS3({ dropPart: 2 });
		await expect(
			createS3Target(CFG, s3.transport).put("bramble/big.bramble", patterned(2 * PART_SIZE + 5)),
		).rejects.toThrow(/every part/);
		expect(s3.objects.has("bramble/big.bramble")).toBe(false);
		expect(s3.uploads.size).toBe(0);
	});

	it("treats an error inside a 200 completion as the failure it is", async () => {
		const s3 = fakeS3({ failComplete: true });
		await expect(
			createS3Target(CFG, s3.transport).put("bramble/big.bramble", patterned(PART_SIZE)),
		).rejects.toThrow(/complete/);
		expect(s3.objects.has("bramble/big.bramble")).toBe(false);
	});

	it("keeps an upload id exactly as the server sent it, numeric or not", async () => {
		const s3 = fakeS3({ uploadId: "00012345678901234567890" });
		await createS3Target(CFG, s3.transport).put("bramble/big.bramble", patterned(PART_SIZE));
		expect(s3.sent.some((r) => r.url.includes("uploadId=00012345678901234567890"))).toBe(true);
		expect(s3.objects.get("bramble/big.bramble")?.length).toBe(PART_SIZE);
	});

	it("sweeps only this vault's stale uploads", async () => {
		const s3 = fakeS3();
		const old = new Date(Date.now() - STALE_UPLOAD_MS - 60_000).toISOString();
		s3.uploads.set("mine", {
			key: "bramble/bramble-x-vaaaaaaaa.bramble",
			parts: new Map(),
			initiated: old,
		});
		s3.uploads.set("theirs", {
			key: "bramble/bramble-x-vbbbbbbbb.bramble",
			parts: new Map(),
			initiated: old,
		});
		s3.uploads.set("fresh", {
			key: "bramble/bramble-y-vaaaaaaaa.bramble",
			parts: new Map(),
			initiated: new Date().toISOString(),
		});
		await createS3Target(CFG, s3.transport).sweepIncomplete?.("bramble/", new Date(), (k) =>
			k.endsWith("-vaaaaaaaa.bramble"),
		);
		expect([...s3.uploads.keys()].sort()).toEqual(["fresh", "theirs"]);
	});
});
