// Content-addressed file blobs and wants (docs/mailbox-service.md, "Files"). Uploads stream
// straight into the BodyStore, which checks the bytes against their hash; the server never
// buffers a blob.

import {
	BlobHashSchema,
	MAX_BLOB_BYTES,
	MailboxIdSchema,
	type PostResponse,
	WantsBodySchema,
} from "@vault/core/src/sync/mailbox/protocol.ts";
import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, Env } from "./app.ts";
import { HttpError, param, signedJson } from "./auth.ts";
import { blobKey, HashMismatchError } from "./bodies.ts";
import { mailboxParam, requireMember } from "./mailboxes.ts";
import { activeMembers, checkQuota } from "./messages.ts";
import { blobDeliveries, blobs, blobWants } from "./schema.ts";
import { chunk, rowsPerInsert } from "./sql.ts";
import { DAY_MS } from "./time.ts";

/** MAX_WANTS hashes of 66 JSON bytes each, with room to spare. */
const WANTS_JSON_BYTES = 1024 * 1024;

class TooLargeError extends Error {}

/** Passes bytes through, refusing more than `limit`, and counts what actually arrived. */
function capped(limit: number) {
	let seen = 0;
	const stream = new TransformStream<Uint8Array, Uint8Array>({
		transform(piece, controller) {
			seen += piece.byteLength;
			if (seen > limit) controller.error(new TooLargeError());
			else controller.enqueue(piece);
		},
	});
	return { stream, received: () => seen };
}

export function blobRoutes(deps: AppDeps) {
	const { db } = deps;
	const hashParam = param(z.object({ id: MailboxIdSchema, hash: BlobHashSchema }));
	const r = new Hono<Env>();

	async function pendingCount(mailboxId: string, hash: string): Promise<number> {
		const row = await db
			.select({ n: count() })
			.from(blobDeliveries)
			.where(and(eq(blobDeliveries.mailboxId, mailboxId), eq(blobDeliveries.hash, hash)))
			.get();
		return row?.n ?? 0;
	}

	r.put("/:id/blobs/:hash", hashParam, async (c) => {
		const { id: mailboxId, hash } = c.req.valid("param");
		const caller = c.var.sigKey;
		// The signature covers contentSha256; the store checks the bytes against the same hash.
		if (c.var.contentSha256 !== hash) throw new HttpError(400, "hash_mismatch");
		const declared = Number(c.req.header("content-length"));
		if (!Number.isSafeInteger(declared) || declared < 0) throw new HttpError(400, "bad_request");
		if (declared > MAX_BLOB_BYTES) throw new HttpError(413, "too_large");

		const { retentionDays } = await requireMember(deps, mailboxId, caller, "active");
		if (!(await deps.entitlement.canPost(mailboxId))) throw new HttpError(402, "collect_only");

		const present = await db
			.select({ hash: blobs.hash })
			.from(blobs)
			.where(and(eq(blobs.mailboxId, mailboxId), eq(blobs.hash, hash)))
			.get();
		if (present) {
			return c.json({
				stored: true,
				recipients: await pendingCount(mailboxId, hash),
			} satisfies PostResponse);
		}
		const recipients = (await activeMembers(deps, mailboxId)).filter((k) => k !== caller);
		if (recipients.length === 0)
			return c.json({ stored: false, recipients: 0 } satisfies PostResponse);
		await checkQuota(deps, mailboxId, declared);

		const body = c.req.raw.body;
		if (!body) throw new HttpError(400, "bad_request");
		const counter = capped(declared);
		try {
			await deps.bodies.put(blobKey(mailboxId, hash), body.pipeThrough(counter.stream), {
				sha256: hash,
			});
		} catch (err) {
			if (err instanceof HashMismatchError) throw new HttpError(400, "hash_mismatch");
			if (err instanceof TooLargeError) throw new HttpError(413, "too_large");
			throw err;
		}

		// Body, then row, then deliveries, as for messages.
		const now = deps.now();
		await db
			.insert(blobs)
			.values({
				mailboxId,
				hash,
				size: counter.received(),
				uploader: caller,
				createdAt: now,
				expiresAt: now + retentionDays * DAY_MS,
			})
			.onConflictDoNothing();
		for (const part of chunk(recipients, rowsPerInsert(3))) {
			await db
				.insert(blobDeliveries)
				.values(part.map((member) => ({ mailboxId, hash, member })))
				.onConflictDoNothing();
		}
		// Every want for it is answered now: those members hold a delivery.
		await db
			.delete(blobWants)
			.where(and(eq(blobWants.mailboxId, mailboxId), eq(blobWants.hash, hash)));
		return c.json({ stored: true, recipients: recipients.length } satisfies PostResponse);
	});

	r.get("/:id/blobs/:hash", hashParam, async (c) => {
		const { id: mailboxId, hash } = c.req.valid("param");
		await requireMember(deps, mailboxId, c.var.sigKey, "active");
		const present = await db
			.select({ hash: blobs.hash })
			.from(blobs)
			.where(and(eq(blobs.mailboxId, mailboxId), eq(blobs.hash, hash)))
			.get();
		const found = present ? await deps.bodies.get(blobKey(mailboxId, hash)) : null;
		if (!found) throw new HttpError(404, "not_found");
		return new Response(found.body, {
			headers: { "content-type": "application/octet-stream", "content-length": String(found.size) },
		});
	});

	r.put("/:id/wants", mailboxParam, ...signedJson(WantsBodySchema, WANTS_JSON_BYTES), async (c) => {
		const { id: mailboxId } = c.req.valid("param");
		const caller = c.var.sigKey;
		await requireMember(deps, mailboxId, caller, "active");
		await db
			.delete(blobWants)
			.where(and(eq(blobWants.mailboxId, mailboxId), eq(blobWants.member, caller)));
		const now = deps.now();
		const rows = [...new Set(c.req.valid("json").hashes)].map((hash) => ({
			mailboxId,
			member: caller,
			hash,
			createdAt: now,
		}));
		for (const part of chunk(rows, rowsPerInsert(4))) await db.insert(blobWants).values(part);
		return c.body(null, 204);
	});

	return r;
}
