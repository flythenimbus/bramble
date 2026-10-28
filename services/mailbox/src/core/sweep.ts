// The retention sweep: hourly on the Node server, a cron trigger on the hosted one. Idempotent,
// and ordered as docs/mailbox-service.md ("Retention") and the plan describe. Rows go before bodies,
// so a crash leaves orphans for the next pass, never an early deletion.

import { and, count, eq, gte, inArray, isNotNull, lt, lte, notExists, sql } from "drizzle-orm";
import type { AppDeps } from "./app.ts";
import { blobKey, messageKey } from "./bodies.ts";
import {
	blobDeliveries,
	blobs,
	deliveries,
	expiryMarkers,
	mailboxes,
	members,
	messages,
} from "./schema.ts";
import { chunk, IN_LIST } from "./sql.ts";
import { DAY_MS, dayOf } from "./time.ts";

/** A body younger than this may belong to a post whose row is not written yet. */
export const ORPHAN_GRACE_MS = 3_600_000;

export interface SweepReport {
	messages: number;
	blobs: number;
	markers: number;
	mailboxes: number;
	orphans: number;
}

const KEY = /^(m|b)\/([^/]+)\/([^/]+)$/;

function byMailbox<T extends { mailboxId: string }>(rows: T[]): Map<string, T[]> {
	const out = new Map<string, T[]>();
	for (const row of rows) out.set(row.mailboxId, [...(out.get(row.mailboxId) ?? []), row]);
	return out;
}

export async function sweep(deps: AppDeps): Promise<SweepReport> {
	const { db, bodies } = deps;
	const now = deps.now();
	const cutoff = now - deps.config.retentionMaxDays * DAY_MS;
	const report: SweepReport = { messages: 0, blobs: 0, markers: 0, mailboxes: 0, orphans: 0 };

	async function addMarker(mailboxId: string, member: string, sender: string, n: number) {
		const updated = await db
			.update(expiryMarkers)
			.set({ count: sql`${expiryMarkers.count} + ${n}`, expiredAt: now })
			.where(
				and(
					eq(expiryMarkers.mailboxId, mailboxId),
					eq(expiryMarkers.member, member),
					eq(expiryMarkers.sender, sender),
				),
			)
			.returning({ id: expiryMarkers.id });
		if (updated.length === 0) {
			await db
				.insert(expiryMarkers)
				.values({ mailboxId, member, sender, count: n, expiredAt: now });
		}
	}

	async function deleteMessages(mailboxId: string, ids: string[]): Promise<number> {
		const gone = await db
			.delete(messages)
			.where(and(eq(messages.mailboxId, mailboxId), inArray(messages.id, ids)))
			.returning({ id: messages.id });
		for (const { id } of gone) await bodies.delete(messageKey(mailboxId, id));
		return gone.length;
	}

	async function deleteBlobs(mailboxId: string, hashes: string[]): Promise<number> {
		const gone = await db
			.delete(blobs)
			.where(and(eq(blobs.mailboxId, mailboxId), inArray(blobs.hash, hashes)))
			.returning({ hash: blobs.hash });
		for (const { hash } of gone) await bodies.delete(blobKey(mailboxId, hash));
		return gone.length;
	}

	// 1. Expired messages: a marker per (recipient, sender) that missed one, then the messages.
	for (;;) {
		const expired = await db
			.select({ mailboxId: messages.mailboxId, id: messages.id })
			.from(messages)
			.where(lte(messages.expiresAt, now))
			.limit(IN_LIST);
		if (expired.length === 0) break;
		for (const [mailboxId, rows] of byMailbox(expired)) {
			const ids = rows.map((r) => r.id);
			const missed = await db
				.select({ member: deliveries.member, sender: messages.sender, n: count() })
				.from(deliveries)
				.innerJoin(
					messages,
					and(eq(messages.mailboxId, deliveries.mailboxId), eq(messages.id, deliveries.messageId)),
				)
				.where(and(eq(deliveries.mailboxId, mailboxId), inArray(deliveries.messageId, ids)))
				.groupBy(deliveries.member, messages.sender);
			for (const m of missed) await addMarker(mailboxId, m.member, m.sender, m.n);
			report.messages += await deleteMessages(mailboxId, ids);
		}
	}

	// 2. Expired blobs. No marker: a returning device wants what its manifest names.
	for (;;) {
		const expired = await db
			.select({ mailboxId: blobs.mailboxId, hash: blobs.hash })
			.from(blobs)
			.where(lte(blobs.expiresAt, now))
			.limit(IN_LIST);
		if (expired.length === 0) break;
		for (const [mailboxId, rows] of byMailbox(expired)) {
			report.blobs += await deleteBlobs(
				mailboxId,
				rows.map((r) => r.hash),
			);
		}
	}

	// 3. Markers older than the ceiling.
	const oldMarkers = await db
		.delete(expiryMarkers)
		.where(lt(expiryMarkers.expiredAt, cutoff))
		.returning({ id: expiryMarkers.id });
	report.markers += oldMarkers.length;

	// 4. Mailboxes no member has checked in to for the ceiling (a never-checked member counts from
	// the mailbox's creation). The foreign keys cascade every row; the bodies follow.
	const abandoned = await db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(
			and(
				lt(mailboxes.createdAt, cutoff),
				notExists(
					db
						.select({ one: sql`1` })
						.from(members)
						.where(
							and(
								eq(members.mailboxId, mailboxes.id),
								isNotNull(members.lastCheckedDay),
								gte(members.lastCheckedDay, dayOf(cutoff)),
							),
						),
				),
			),
		);
	for (const { id } of abandoned) {
		const messageIds = await db
			.select({ id: messages.id })
			.from(messages)
			.where(eq(messages.mailboxId, id));
		const hashes = await db.select({ hash: blobs.hash }).from(blobs).where(eq(blobs.mailboxId, id));
		await db.delete(mailboxes).where(eq(mailboxes.id, id));
		for (const m of messageIds) await bodies.delete(messageKey(id, m.id));
		for (const b of hashes) await bodies.delete(blobKey(id, b.hash));
		report.mailboxes++;
	}

	// 5. Leftovers: rows with no deliveries, old enough not to be a post still being written.
	const settled = now - ORPHAN_GRACE_MS;
	const strayMessages = await db
		.select({ mailboxId: messages.mailboxId, id: messages.id })
		.from(messages)
		.where(
			and(
				lt(messages.createdAt, settled),
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
		);
	for (const [mailboxId, rows] of byMailbox(strayMessages)) {
		for (const ids of chunk(
			rows.map((r) => r.id),
			IN_LIST,
		)) {
			report.messages += await deleteMessages(mailboxId, ids);
		}
	}
	const strayBlobs = await db
		.select({ mailboxId: blobs.mailboxId, hash: blobs.hash })
		.from(blobs)
		.where(
			and(
				lt(blobs.createdAt, settled),
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
		);
	for (const [mailboxId, rows] of byMailbox(strayBlobs)) {
		for (const hashes of chunk(
			rows.map((r) => r.hash),
			IN_LIST,
		)) {
			report.blobs += await deleteBlobs(mailboxId, hashes);
		}
	}

	// 6. Orphan bodies: no row, and old enough not to be a post still being written.
	for await (const { key, modifiedAt } of bodies.keys()) {
		if (modifiedAt > settled) continue;
		const parsed = KEY.exec(key);
		let owned = false;
		if (parsed?.[1] === "m") {
			owned = !!(await db
				.select({ id: messages.id })
				.from(messages)
				.where(and(eq(messages.mailboxId, parsed[2]!), eq(messages.id, parsed[3]!)))
				.get());
		} else if (parsed?.[1] === "b") {
			owned = !!(await db
				.select({ hash: blobs.hash })
				.from(blobs)
				.where(and(eq(blobs.mailboxId, parsed[2]!), eq(blobs.hash, parsed[3]!)))
				.get());
		}
		if (!owned) {
			await bodies.delete(key);
			report.orphans++;
		}
	}

	return report;
}
