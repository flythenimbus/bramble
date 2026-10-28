// The mailbox server as one Hono app, the same on Node and Workers; storage and payment differences
// arrive through AppDeps. See docs/mailbox-service.md.

import type { ErrorResponse } from "@vault/core/src/sync/mailbox/protocol.ts";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { HttpError, signedRequest, tokenGate } from "./auth.ts";
import { blobRoutes } from "./blobs.ts";
import type { BodyStore } from "./bodies.ts";
import { mailboxRoutes } from "./mailboxes.ts";
import { messageRoutes } from "./messages.ts";
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

export function createApp(deps: AppDeps) {
	const app = new Hono<Env>();
	app.onError((err, c) => {
		if (err instanceof HttpError) {
			const body: ErrorResponse = { error: err.code };
			if (err.serverTime !== undefined) body.serverTime = err.serverTime;
			return c.json(body, err.status);
		}
		return c.body(null, 500);
	});
	app.notFound((c) => c.json({ error: "not_found" } satisfies ErrorResponse, 404));
	app.get("/health", (c) => c.text("ok"));
	app.use("/v1/*", tokenGate(deps.config.token), signedRequest(deps.now));
	app.route("/v1/mailboxes", mailboxRoutes(deps));
	app.route("/v1/mailboxes", messageRoutes(deps));
	app.route("/v1/mailboxes", blobRoutes(deps));
	return app;
}
