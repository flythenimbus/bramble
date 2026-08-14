import { afterEach, describe, expect, it, vi } from "vitest";
import { createS3Target } from "./s3";
import type { BackupHttpRequest, BackupTransport, S3Config } from "./types";

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

		await target.put("bramble/x.bramble", new Uint8Array([1, 2, 3]), "application/octet-stream");
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
