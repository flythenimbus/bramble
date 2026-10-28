import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MembersResponseSchema } from "@vault/core/src/sync/mailbox/protocol.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRemoteDevice } from "../test/harness.ts";
import { startServer } from "./server.ts";

describe("startServer", () => {
	let dataDir: string;
	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mailbox-server-"));
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("serves health, accepts a signed create, and keeps data across a restart", async () => {
		const env = { PORT: "0", DATA_DIR: dataDir };
		let server = await startServer(env);
		const device = await makeRemoteDevice(() => server.url);
		try {
			expect(await (await fetch(`${server.url}/health`)).text()).toBe("ok");
			const id = randomBytes(32).toString("base64url");
			const created = await device.request("POST", `/v1/mailboxes/${id}`, {
				members: [device.sigKey],
			});
			expect(created.status).toBe(200);

			await server.close();
			server = await startServer(env);

			const res = await device.request("GET", `/v1/mailboxes/${id}/members`);
			expect(res.status).toBe(200);
			expect(MembersResponseSchema.parse(await res.json()).members).toEqual([
				{ sigKey: device.sigKey, status: "active", lastCheckedDay: null },
			]);
		} finally {
			await server.close();
		}
	});
});
