// Creating a mailbox and keeping its membership: eligible members are listed by an active one,
// and only an eligible member can make itself active (docs/mailbox-service.md, "Mailboxes and
// members").

import {
	ActivationBodySchema,
	CreateMailboxBodySchema,
	MailboxIdSchema,
	MembersBodySchema,
	type MembersResponse,
	SettingsBodySchema,
} from "@vault/core/src/sync/mailbox/protocol.ts";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, Env } from "./app.ts";
import { HttpError, param, signedJson } from "./auth.ts";
import { dropMember } from "./cleanup.ts";
import { mailboxes, members } from "./schema.ts";

/** Membership bodies are at most 2 x MAX_MEMBERS keys; this leaves ample room. */
const SMALL_JSON_BYTES = 64 * 1024;

export const mailboxParam = param(z.object({ id: MailboxIdSchema }));

export async function requireMember(
	deps: AppDeps,
	mailboxId: string,
	sigKey: string,
	need: "any" | "active",
): Promise<{ status: "eligible" | "active"; retentionDays: number }> {
	const mailbox = await deps.db
		.select({ retentionDays: mailboxes.retentionDays })
		.from(mailboxes)
		.where(eq(mailboxes.id, mailboxId))
		.get();
	if (!mailbox) throw new HttpError(404, "not_found");
	const member = await deps.db
		.select({ status: members.status })
		.from(members)
		.where(and(eq(members.mailboxId, mailboxId), eq(members.sigKey, sigKey)))
		.get();
	if (!member) throw new HttpError(403, "not_member");
	if (need === "active" && member.status !== "active") throw new HttpError(403, "not_active");
	return { status: member.status, retentionDays: mailbox.retentionDays };
}

async function listMembers(deps: AppDeps, mailboxId: string): Promise<MembersResponse> {
	const rows = await deps.db
		.select({
			sigKey: members.sigKey,
			status: members.status,
			lastCheckedDay: members.lastCheckedDay,
		})
		.from(members)
		.where(eq(members.mailboxId, mailboxId))
		.orderBy(asc(members.addedAt), asc(members.sigKey));
	return { members: rows };
}

export function mailboxRoutes(deps: AppDeps) {
	const { db } = deps;
	const clamp = (days: number) => Math.min(days, deps.config.retentionMaxDays);
	const r = new Hono<Env>();

	r.post(
		"/:id",
		mailboxParam,
		...signedJson(CreateMailboxBodySchema, SMALL_JSON_BYTES),
		async (c) => {
			const { id } = c.req.valid("param");
			const body = c.req.valid("json");
			const caller = c.var.sigKey;
			if (!body.members.includes(caller)) throw new HttpError(400, "bad_request");
			const now = deps.now();
			const created = await db
				.insert(mailboxes)
				.values({
					id,
					retentionDays: clamp(body.retentionDays ?? deps.config.retentionMaxDays),
					createdAt: now,
				})
				.onConflictDoNothing()
				.returning({ id: mailboxes.id });
			if (created.length === 0) throw new HttpError(409, "exists");
			await db.insert(members).values(
				[...new Set(body.members)].map((sigKey) => ({
					mailboxId: id,
					sigKey,
					status: sigKey === caller ? ("active" as const) : ("eligible" as const),
					addedAt: now,
				})),
			);
			return c.json(await listMembers(deps, id));
		},
	);

	r.patch("/:id", mailboxParam, ...signedJson(SettingsBodySchema, SMALL_JSON_BYTES), async (c) => {
		const { id } = c.req.valid("param");
		await requireMember(deps, id, c.var.sigKey, "active");
		await db
			.update(mailboxes)
			.set({ retentionDays: clamp(c.req.valid("json").retentionDays) })
			.where(eq(mailboxes.id, id));
		return c.body(null, 204);
	});

	r.get("/:id/members", mailboxParam, async (c) => {
		const { id } = c.req.valid("param");
		await requireMember(deps, id, c.var.sigKey, "any");
		return c.json(await listMembers(deps, id));
	});

	r.post(
		"/:id/members",
		mailboxParam,
		...signedJson(MembersBodySchema, SMALL_JSON_BYTES),
		async (c) => {
			const { id } = c.req.valid("param");
			await requireMember(deps, id, c.var.sigKey, "active");
			const { add, remove } = c.req.valid("json");
			const now = deps.now();
			if (add.length > 0) {
				await db
					.insert(members)
					.values(
						[...new Set(add)].map((sigKey) => ({
							mailboxId: id,
							sigKey,
							status: "eligible" as const,
							addedAt: now,
						})),
					)
					.onConflictDoNothing();
			}
			for (const sigKey of new Set(remove)) await dropMember(deps, id, sigKey, false);
			return c.json(await listMembers(deps, id));
		},
	);

	r.post(
		"/:id/activation",
		mailboxParam,
		...signedJson(ActivationBodySchema, SMALL_JSON_BYTES),
		async (c) => {
			const { id } = c.req.valid("param");
			const caller = c.var.sigKey;
			try {
				await requireMember(deps, id, caller, "any");
			} catch (err) {
				if (err instanceof HttpError && err.code === "not_member")
					throw new HttpError(403, "not_eligible");
				throw err;
			}
			const { active } = c.req.valid("json");
			if (!active) await dropMember(deps, id, caller, true);
			await db
				.update(members)
				.set({ status: active ? "active" : "eligible" })
				.where(and(eq(members.mailboxId, id), eq(members.sigKey, caller)));
			return c.json(await listMembers(deps, id));
		},
	);

	return r;
}
