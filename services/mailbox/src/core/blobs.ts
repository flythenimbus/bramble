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
import { and, count, eq, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, Env } from "./app.ts";
import { HttpError, param, signedJson } from "./auth.ts";
import { blobKey } from "./bodies.ts";
import { deleteUndelivered } from "./cleanup.ts";
import { mailboxParam, requireMember } from "./mailboxes.ts";
import { checkQuota } from "./messages.ts";
import { blobDeliveries, blobs, blobWants, members } from "./schema.ts";
import { chunk, rowsPerInsert } from "./sql.ts";
import { DAY_MS } from "./time.ts";
import { declaredLength, storeUpload } from "./upload.ts";

/** MAX_WANTS hashes of 66 JSON bytes each, with room to spare. */
const WANTS_JSON_BYTES = 1024 * 1024;

export function blobRoutes(deps: AppDeps) {
	const { db } = deps;
	const hashParam = param(z.object({ id: MailboxIdSchema, hash: BlobHashSchema }));
	const r = new Hono<Env>();

	/** Every active member but the uploader. */
	function targets(mailboxId: string, caller: string) {
		return and(
			eq(members.mailboxId, mailboxId),
			eq(members.status, "active"),
			ne(members.sigKey, caller),
		);
	}

	async function countOf(where: ReturnType<typeof targets>): Promise<number> {
		return (await db.select({ n: count() }).from(members).where(where).get())?.n ?? 0;
	}

	/**
	 * Deliver `hash` to the targets as they are now, in one statement, as messages do; running it
	 * again fills in what an earlier attempt never wrote. Every want for it is answered after.
	 */
	async function deliver(mailboxId: string, hash: string, where: ReturnType<typeof targets>) {
		await db
			.insert(blobDeliveries)
			.select(
				db
					.select({
						mailboxId: sql<string>`${mailboxId}`.as("mailbox_id"),
						hash: sql<string>`${hash}`.as("hash"),
						member: members.sigKey,
					})
					.from(members)
					.where(where),
			)
			.onConflictDoNothing();
		await db
			.delete(blobWants)
			.where(and(eq(blobWants.mailboxId, mailboxId), eq(blobWants.hash, hash)));
		return countOf(where);
	}

	r.put("/:id/blobs/:hash", hashParam, async (c) => {
		const { id: mailboxId, hash } = c.req.valid("param");
		const caller = c.var.sigKey;
		// The signature covers contentSha256; the store checks the bytes against the same hash.
		if (c.var.contentSha256 !== hash) throw new HttpError(400, "hash_mismatch");
		const declared = declaredLength(c, MAX_BLOB_BYTES);
		const { retentionDays } = await requireMember(deps, mailboxId, caller, "active");
		if (!(await deps.entitlement.canPost(mailboxId))) throw new HttpError(402, "collect_only");
		const where = targets(mailboxId, caller);

		const present = await db
			.select({ hash: blobs.hash })
			.from(blobs)
			.where(and(eq(blobs.mailboxId, mailboxId), eq(blobs.hash, hash)))
			.get();
		if (present) {
			// Held already: make sure every target has a delivery, without reading the body.
			return c.json({
				stored: true,
				recipients: await deliver(mailboxId, hash, where),
			} satisfies PostResponse);
		}
		if ((await countOf(where)) === 0)
			return c.json({ stored: false, recipients: 0 } satisfies PostResponse);
		await checkQuota(deps, mailboxId, declared);

		// Body, then row, then deliveries, as for messages.
		const size = await storeUpload(
			deps,
			c,
			blobKey(mailboxId, hash),
			declared,
			hash,
			new HttpError(400, "hash_mismatch"),
		);
		const now = deps.now();
		await db
			.insert(blobs)
			.values({
				mailboxId,
				hash,
				size,
				uploader: caller,
				createdAt: now,
				expiresAt: now + retentionDays * DAY_MS,
			})
			.onConflictDoNothing();
		const recipients = await deliver(mailboxId, hash, where);
		if (recipients === 0) {
			// Everyone it was for left while it was being written.
			await deleteUndelivered(deps, mailboxId, { messages: [], blobs: [hash] });
			return c.json({ stored: false, recipients: 0 } satisfies PostResponse);
		}
		return c.json({ stored: true, recipients } satisfies PostResponse);
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
