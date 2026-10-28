// Who is asking: a roster Ed25519 key signing canonicalRequest (docs/mailbox-service.md, "Keys and
// identity"), plus the optional private-server token. Errors never echo input.

import { zValidator } from "@hono/zod-validator";
import {
	BLOB_HASH_RE,
	canonicalRequest,
	HEADERS,
	MAX_CLOCK_SKEW_MS,
	type MailboxErrorCode,
	SIG_KEY_RE,
	sha256Hex,
} from "@vault/core/src/sync/mailbox/protocol.ts";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { Env } from "./app.ts";
import { fromBase64 } from "./base64.ts";

export class HttpError extends Error {
	readonly status: ContentfulStatusCode;
	readonly code: MailboxErrorCode;
	readonly serverTime: number | undefined;
	constructor(status: ContentfulStatusCode, code: MailboxErrorCode, serverTime?: number) {
		super(code);
		this.status = status;
		this.code = code;
		this.serverTime = serverTime;
	}
}

export const SigningHeadersSchema = z.object({
	[HEADERS.key]: z.string().regex(SIG_KEY_RE),
	[HEADERS.time]: z
		.string()
		.regex(/^\d{1,16}$/)
		.transform(Number),
	[HEADERS.contentSha256]: z.string().regex(BLOB_HASH_RE),
	/** 64 bytes, standard base64. */
	[HEADERS.sig]: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});

const JSON_TYPE = /^application\/json(;|$)/i;

async function verifyEd25519(publicB64: string, sigB64: string, message: string): Promise<boolean> {
	try {
		const key = await crypto.subtle.importKey(
			"raw",
			fromBase64(publicB64),
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		return await crypto.subtle.verify(
			{ name: "Ed25519" },
			key,
			fromBase64(sigB64),
			new TextEncoder().encode(message),
		);
	} catch {
		return false;
	}
}

function constantTimeEqual(a: string, b: string): boolean {
	const x = new TextEncoder().encode(a);
	const y = new TextEncoder().encode(b);
	let diff = x.length ^ y.length;
	for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}

export function tokenGate(token: string | null) {
	return createMiddleware<Env>(async (c, next) => {
		if (token !== null && !constantTimeEqual(c.req.header(HEADERS.token) ?? "", token)) {
			throw new HttpError(403, "token_required");
		}
		await next();
	});
}

export function signedRequest(now: () => number) {
	return createMiddleware<Env>(async (c, next) => {
		const parsed = SigningHeadersSchema.safeParse(c.req.header());
		if (!parsed.success) throw new HttpError(401, "bad_signature");
		const h = parsed.data;
		const time = h[HEADERS.time];
		const serverTime = now();
		if (Math.abs(serverTime - time) > MAX_CLOCK_SKEW_MS)
			throw new HttpError(401, "stale_time", serverTime);
		const url = new URL(c.req.url);
		const message = canonicalRequest({
			method: c.req.method,
			pathAndQuery: url.pathname + url.search,
			time,
			contentSha256: h[HEADERS.contentSha256],
		});
		if (!(await verifyEd25519(h[HEADERS.key], h[HEADERS.sig], message))) {
			throw new HttpError(401, "bad_signature");
		}
		c.set("sigKey", h[HEADERS.key]);
		c.set("contentSha256", h[HEADERS.contentSha256]);
		await next();
	});
}

/** The shared zValidator hook: a failure is `bad_request`, never an echo of what was sent. */
export function validationHook(result: { success: boolean }, c: Context) {
	if (!result.success) return c.json({ error: "bad_request" satisfies MailboxErrorCode }, 400);
}

/** Size limit, then the signed body hash, then the schema. Hono caches the body, so it is read once. */
export function signedJson<S extends z.ZodType>(schema: S, maxBytes: number) {
	return [
		bodyLimit({
			maxSize: maxBytes,
			onError: (c) => c.json({ error: "too_large" satisfies MailboxErrorCode }, 413),
		}),
		createMiddleware<Env>(async (c, next) => {
			// Without a JSON content type, the validator would read the body as {} and say nothing.
			if (!JSON_TYPE.test(c.req.header("content-type") ?? ""))
				throw new HttpError(400, "bad_request");
			const bytes = new Uint8Array(await c.req.arrayBuffer());
			if ((await sha256Hex(bytes)) !== c.var.contentSha256)
				throw new HttpError(401, "bad_signature");
			await next();
		}),
		zValidator("json", schema, validationHook),
	] as const;
}

export function param<S extends z.ZodType>(schema: S) {
	return zValidator("param", schema, validationHook);
}
