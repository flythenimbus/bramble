// The mailbox server as one Hono app, the same on Node and Workers; storage and payment differences
// arrive through AppDeps. See docs/mailbox-service.md.

import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import type { BodyStore } from "./bodies.ts";
import type * as schema from "./schema.ts";

// better-sqlite3 (sync) and D1 (async) both fit; every call is awaited.
export type Db = BaseSQLiteDatabase<any, any, typeof schema>;

/** Whether a mailbox may take new posts and uploads. Collecting is never gated. */
export interface Entitlement {
	canPost(mailboxId: string): Promise<boolean>;
}

export interface AppDeps {
	db: Db;
	bodies: BodyStore;
	entitlement: Entitlement;
	now: () => number;
	config: { retentionMaxDays: number; quotaBytes: number | null; token: string | null };
}

export type Env = { Variables: { sigKey: string; contentSha256: string } };

export function createApp(_deps: AppDeps) {
	const app = new Hono<Env>();
	app.get("/health", (c) => c.text("ok"));
	return app;
}
