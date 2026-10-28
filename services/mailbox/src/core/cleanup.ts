// Deleting what nobody awaits. Scoped to candidate ids (just acknowledged, replaced, or once
// addressed to a member now gone): a post writes its message row before its delivery rows, so an
// unscoped "no deliveries left" delete could take a message still being posted. The sweep's global
// pass covers leftovers, with an age grace for the same reason.

import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import type { AppDeps } from "./app.ts";
import { blobKey, messageKey } from "./bodies.ts";
import {
	blobDeliveries,
	blobs,
	blobWants,
	deliveries,
	expiryMarkers,
	members,
	messages,
} from "./schema.ts";
import { chunk, IN_LIST } from "./sql.ts";

export interface Candidates {
	messages: string[];
	blobs: string[];
}

/** Rows first, then bodies: a crash between them leaves an orphan body, never an early deletion. */
export async function deleteUndelivered(
	deps: AppDeps,
	mailboxId: string,
	candidates: Candidates,
): Promise<number> {
	const { db, bodies } = deps;
	let deleted = 0;
	for (const ids of chunk(candidates.messages, IN_LIST)) {
		const gone = await db
			.delete(messages)
			.where(
				and(
					eq(messages.mailboxId, mailboxId),
					inArray(messages.id, ids),
					notExists(
						db
							.select({ one: sql`1` })
							.from(deliveries)
							.where(
								and(
									eq(deliveries.mailboxId, messages.mailboxId),
									eq(deliveries.messageId, messages.id),
								),
							),
					),
				),
			)
			.returning({ id: messages.id });
		for (const { id } of gone) await bodies.delete(messageKey(mailboxId, id));
		deleted += gone.length;
	}
	for (const hashes of chunk(candidates.blobs, IN_LIST)) {
		const gone = await db
			.delete(blobs)
			.where(
				and(
					eq(blobs.mailboxId, mailboxId),
					inArray(blobs.hash, hashes),
					notExists(
						db
							.select({ one: sql`1` })
							.from(blobDeliveries)
							.where(
								and(
									eq(blobDeliveries.mailboxId, blobs.mailboxId),
									eq(blobDeliveries.hash, blobs.hash),
								),
							),
					),
				),
			)
			.returning({ hash: blobs.hash });
		for (const { hash } of gone) await bodies.delete(blobKey(mailboxId, hash));
		deleted += gone.length;
	}
	return deleted;
}

/**
 * Remove a member's pending deliveries, wants and markers (and, unless `keepRow`, the member), then
 * delete whatever no one else awaits. Returns how many messages and blobs went.
 */
export async function dropMember(
	deps: AppDeps,
	mailboxId: string,
	sigKey: string,
	keepRow: boolean,
): Promise<number> {
	const { db } = deps;
	const mine = <
		T extends typeof deliveries | typeof blobDeliveries | typeof blobWants | typeof expiryMarkers,
	>(
		t: T,
	) => and(eq(t.mailboxId, mailboxId), eq(t.member, sigKey));
	const candidates: Candidates = {
		messages: (
			await db.select({ id: deliveries.messageId }).from(deliveries).where(mine(deliveries))
		).map((r) => r.id),
		blobs: (
			await db
				.select({ hash: blobDeliveries.hash })
				.from(blobDeliveries)
				.where(mine(blobDeliveries))
		).map((r) => r.hash),
	};
	if (keepRow) {
		await db.delete(deliveries).where(mine(deliveries));
		await db.delete(blobDeliveries).where(mine(blobDeliveries));
		await db.delete(blobWants).where(mine(blobWants));
		await db.delete(expiryMarkers).where(mine(expiryMarkers));
	} else {
		// The foreign keys cascade the member's deliveries, wants and markers.
		await db
			.delete(members)
			.where(and(eq(members.mailboxId, mailboxId), eq(members.sigKey, sigKey)));
	}
	return deleteUndelivered(deps, mailboxId, candidates);
}
