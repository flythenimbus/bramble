import { EMPTY_SHA256 } from "@vault/core/src/sync/mailbox/protocol.ts";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb } from "../node/db.ts";
import { makeServer, memoryBodies } from "../test/harness.ts";
import { HashMismatchError } from "./bodies.ts";

describe("server skeleton", () => {
	it("answers the health probe", async () => {
		const { app } = makeServer();
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
	});

	it("creates every table from the migrations", () => {
		const { db } = openDb(":memory:");
		const names = db
			.all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`)
			.map((r: { name: string }) => r.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"mailboxes",
				"members",
				"messages",
				"deliveries",
				"blobs",
				"blob_deliveries",
				"blob_wants",
				"expiry_markers",
			]),
		);
	});

	it("memoryBodies refuses bytes that do not match the declared hash", async () => {
		const bodies = memoryBodies();
		await expect(
			bodies.put("b/x/y", new Uint8Array([1]), { sha256: EMPTY_SHA256 }),
		).rejects.toBeInstanceOf(HashMismatchError);
		expect(await bodies.get("b/x/y")).toBeNull();
	});
});
