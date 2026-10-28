import { randomBytes } from "node:crypto";
import {
	INBOX_PAGE,
	MAX_MESSAGE_BYTES,
	PostResponseSchema,
} from "@vault/core/src/sync/mailbox/protocol.ts";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
	ack,
	activate,
	createMailbox,
	gatedBodies,
	inbox,
	inboxIds,
	memberStatuses,
	newMessageId,
	postMessage,
	replaceMessages,
	setup,
	type TestServer,
} from "../test/harness.ts";
import { blobs, deliveries, messages } from "./schema.ts";
import { chunk } from "./sql.ts";
import { DAY_MS } from "./time.ts";

async function trio(opts: Parameters<typeof setup>[1] = {}) {
	const { server, devices } = await setup(4, opts);
	const [a, b, c, eligible] = [devices[0]!, devices[1]!, devices[2]!, devices[3]!];
	const id = await createMailbox(a, [b, c, eligible]);
	await activate(id, b, c);
	return { server, a, b, c, eligible, id };
}

describe("posting", () => {
	it("delivers to every other active member and to nobody eligible", async () => {
		const { a, b, c, eligible, id } = await trio();
		const { res, msgId } = await postMessage(a, id);
		expect(PostResponseSchema.parse(await res.json())).toEqual({ stored: true, recipients: 2 });
		expect(await inboxIds(b, id)).toEqual([msgId]);
		expect(await inboxIds(c, id)).toEqual([msgId]);
		expect(await inboxIds(a, id)).toEqual([]);
		const res2 = await eligible.request("GET", `/v1/mailboxes/${id}/inbox`);
		expect(res2.status).toBe(403);
		expect(await res2.json()).toEqual({ error: "not_active" });
	});

	it("addresses only the members named in `to`", async () => {
		const { a, b, c, id } = await trio();
		const { msgId } = await postMessage(a, id, { to: [b] });
		expect(await inboxIds(b, id)).toEqual([msgId]);
		expect(await inboxIds(c, id)).toEqual([]);
	});

	it("stores nothing when there is nobody to deliver to", async () => {
		const { devices } = await setup(1);
		const a = devices[0]!;
		const id = await createMailbox(a);
		const { res } = await postMessage(a, id);
		expect(await res.json()).toEqual({ stored: false, recipients: 0 });
		expect((await inbox(a, id)).usedBytes).toBe(0);
	});

	it("treats a repeated id from the same sender as the same post", async () => {
		const { a, b, id } = await trio();
		const msgId = newMessageId();
		const first = await (await postMessage(a, id, { msgId })).res.json();
		const again = await (await postMessage(a, id, { msgId })).res.json();
		expect(again).toEqual(first);
		expect(await inboxIds(b, id)).toEqual([msgId]);
	});

	it("refuses another member's id", async () => {
		const { a, b, c, id } = await trio();
		const { msgId } = await postMessage(a, id, { to: [c] });
		const { res } = await postMessage(b, id, { msgId, to: [c] });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "id_conflict" });
		expect((await inbox(c, id)).messages).toEqual([
			expect.objectContaining({ id: msgId, sender: a.sigKey }),
		]);
	});

	it("refuses a post that would exceed the quota", async () => {
		const { a, id } = await trio({ quotaBytes: 10 });
		const { res } = await postMessage(a, id, { bytes: randomBytes(11) });
		expect(res.status).toBe(507);
		expect(await res.json()).toEqual({ error: "quota_exceeded" });
	});

	it("refuses posts but serves the inbox and acks when the entitlement says collect-only", async () => {
		const { a, b, id } = await trio({ canPost: false });
		const { res } = await postMessage(a, id);
		expect(res.status).toBe(402);
		expect(await res.json()).toEqual({ error: "collect_only" });
		expect((await inbox(b, id)).messages).toEqual([]);
		await ack(b, id, { messages: [newMessageId()] });
	});
});

describe("collecting", () => {
	it("keeps a message until the last recipient acknowledges it", async () => {
		const { server, a, b, c, id } = await trio();
		const { msgId } = await postMessage(a, id);
		await ack(b, id, { messages: [msgId] });
		expect((await c.request("GET", `/v1/mailboxes/${id}/messages/${msgId}`)).status).toBe(200);
		await ack(c, id, { messages: [msgId] });
		expect(await inboxIds(c, id)).toEqual([]);
		expect(await server.deps.bodies.get(`m/${id}/${msgId}`)).toBeNull();
		expect((await inbox(a, id)).usedBytes).toBe(0);
	});

	it("never deletes what the caller did not hold, even mid-post before its deliveries exist", async () => {
		const { server, a, c, id } = await trio();
		const { db, bodies } = server.deps;
		const now = server.clock.now;
		const msgId = newMessageId();
		const hash = "a".repeat(64);
		// Body and row written, deliveries not yet: the state a post passes through on D1.
		await bodies.put(`m/${id}/${msgId}`, new Uint8Array([1]));
		await db.insert(messages).values({
			mailboxId: id,
			id: msgId,
			sender: a.sigKey,
			size: 1,
			createdAt: now,
			expiresAt: now + DAY_MS,
		});
		await bodies.put(`b/${id}/${hash}`, new Uint8Array([2]));
		await db.insert(blobs).values({
			mailboxId: id,
			hash,
			size: 1,
			uploader: a.sigKey,
			createdAt: now,
			expiresAt: now + DAY_MS,
		});
		await ack(c, id, { messages: [msgId], blobs: [hash] });
		expect(await bodies.get(`m/${id}/${msgId}`)).not.toBeNull();
		expect(await bodies.get(`b/${id}/${hash}`)).not.toBeNull();
		expect(await db.select().from(messages).all()).toHaveLength(1);
		expect(await db.select().from(blobs).all()).toHaveLength(1);
	});

	it("ignores acks for messages the caller was never sent", async () => {
		const { a, b, c, id } = await trio();
		const { msgId } = await postMessage(a, id, { to: [b] });
		await ack(c, id, { messages: [msgId, newMessageId()] });
		expect(await inboxIds(b, id)).toEqual([msgId]);
	});

	it("serves a body only to a pending recipient", async () => {
		const { a, b, c, id } = await trio();
		const bytes = randomBytes(32);
		const { msgId } = await postMessage(a, id, { bytes, to: [b] });
		const res = await b.request("GET", `/v1/mailboxes/${id}/messages/${msgId}`);
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(bytes));
		expect((await c.request("GET", `/v1/mailboxes/${id}/messages/${msgId}`)).status).toBe(404);
		expect((await a.request("GET", `/v1/mailboxes/${id}/messages/${msgId}`)).status).toBe(404);
	});

	it("refuses a malformed message id", async () => {
		const { b, id } = await trio();
		const res = await b.request("GET", `/v1/mailboxes/${id}/messages/not-an-id`);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "bad_request" });
	});

	it("pages the inbox and records the caller's check-in day", async () => {
		const { server, a, b, id } = await trio();
		for (let i = 0; i <= INBOX_PAGE; i++) await postMessage(a, id, { to: [b] });
		const first = await inbox(b, id);
		expect(first.messages).toHaveLength(INBOX_PAGE);
		expect(first.more).toBe(true);
		const res = await a.request("GET", `/v1/mailboxes/${id}/members`);
		const { members } = (await res.json()) as {
			members: { sigKey: string; lastCheckedDay: number | null }[];
		};
		const day = Math.floor(server.clock.now / 86_400_000);
		expect(members.find((m) => m.sigKey === b.sigKey)?.lastCheckedDay).toBe(day);
		expect(first.serverTime).toBe(server.clock.now);
	});
});

describe("compaction", () => {
	it("lets a snapshot replace only its sender's messages, only for its recipients", async () => {
		const { a, b, c, id } = await trio();
		const { msgId: m1 } = await postMessage(a, id);
		const { msgId: m2 } = await postMessage(a, id);
		await ack(b, id, { messages: [m1] });
		const { msgId: fromB } = await postMessage(b, id, { to: [c] });
		const { msgId: s } = await postMessage(a, id, { to: [c] });
		expect((await replaceMessages(a, id, s, [m1, m2, fromB])).status).toBe(204);
		expect(await inboxIds(c, id)).toEqual([fromB, s].sort());
		expect(await inboxIds(b, id)).toEqual([m2]);
	});

	it("lets only a snapshot's sender name what it replaces", async () => {
		const { a, b, c, id } = await trio();
		const { msgId: m1 } = await postMessage(a, id, { to: [c] });
		const { msgId: s } = await postMessage(a, id, { to: [c] });
		const res = await replaceMessages(b, id, s, [m1]);
		expect(res.status).toBe(404);
		expect(await inboxIds(c, id)).toEqual([m1, s].sort());
	});
});

describe("chunk", () => {
	it("splits a list into pieces no longer than the size, in order", () => {
		expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
		expect(chunk([], 2)).toEqual([]);
	});
});

describe("membership cleanup", () => {
	it("removing a member drops its pending deliveries and deletes what nobody else awaits", async () => {
		const { server, a, b, id } = await trio();
		const { msgId } = await postMessage(a, id, { to: [b] });
		expect(
			(await a.request("POST", `/v1/mailboxes/${id}/members`, { remove: [b.sigKey] })).status,
		).toBe(200);
		expect(await server.deps.bodies.get(`m/${id}/${msgId}`)).toBeNull();
		expect((await inbox(a, id)).usedBytes).toBe(0);
	});

	it("deactivating stops deliveries to the member and deletes what nobody else awaits", async () => {
		const { server, a, b, c, id } = await trio();
		const { msgId } = await postMessage(a, id, { to: [b] });
		expect(
			(await b.request("POST", `/v1/mailboxes/${id}/activation`, { active: false })).status,
		).toBe(200);
		expect(await server.deps.bodies.get(`m/${id}/${msgId}`)).toBeNull();
		expect((await memberStatuses(a, id))[b.sigKey]).toBe("eligible");
		const { msgId: next } = await postMessage(a, id);
		expect(await inboxIds(c, id)).toEqual([next]);
	});
});

describe("raw bodies", () => {
	it("refuses a body that does not match its signed hash, and keeps nothing", async () => {
		const { server, a, b, id } = await trio();
		const { res } = await postMessage(a, id, { request: { sendBytes: randomBytes(8) } });
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "bad_signature" });
		expect(await inboxIds(b, id)).toEqual([]);
		let n = 0;
		for await (const _ of server.deps.bodies.keys()) n++;
		expect(n).toBe(0);
	});

	it("refuses a declared length over MAX_MESSAGE_BYTES without reading the body", async () => {
		const { a, id } = await trio();
		const { res } = await postMessage(a, id, {
			request: { headers: { "content-length": String(MAX_MESSAGE_BYTES + 1) } },
		});
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "too_large" });
	});
});

describe("membership changing mid-post", () => {
	async function gatedTrio() {
		const gate = gatedBodies();
		const { server, devices } = await setup(3, { wrapBodies: gate.wrap });
		const [a, b, c] = [devices[0]!, devices[1]!, devices[2]!];
		const id = await createMailbox(a, [b, c]);
		await activate(id, b, c);
		return { gate, server, a, b, c, id };
	}

	const recipientsOf = async (server: TestServer, msgId: string) =>
		(await server.deps.db.select().from(deliveries).where(eq(deliveries.messageId, msgId)).all())
			.map((d: { member: string }) => d.member)
			.sort();

	it("delivers to whoever is active when the post lands, when a member is removed during it", async () => {
		const { gate, server, a, b, c, id } = await gatedTrio();
		gate.hold();
		const posting = postMessage(a, id);
		await gate.entered();
		expect(
			(await a.request("POST", `/v1/mailboxes/${id}/members`, { remove: [c.sigKey] })).status,
		).toBe(200);
		gate.release();
		const { res, msgId } = await posting;
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ stored: true, recipients: 1 });
		expect(await recipientsOf(server, msgId)).toEqual([b.sigKey]);
	});

	it("does not address a member that deactivated during the post", async () => {
		const { gate, server, a, b, c, id } = await gatedTrio();
		gate.hold();
		const posting = postMessage(a, id);
		await gate.entered();
		expect(
			(await b.request("POST", `/v1/mailboxes/${id}/activation`, { active: false })).status,
		).toBe(200);
		gate.release();
		const { msgId } = await posting;
		expect(await recipientsOf(server, msgId)).toEqual([c.sigKey]);
	});

	it("restores deliveries a failed attempt never wrote when the post is repeated", async () => {
		const { server, a, b, c, id } = await trio();
		const msgId = newMessageId();
		const bytes = randomBytes(8);
		const now = server.clock.now;
		// What a post that died after its row and before its deliveries leaves behind.
		await server.deps.bodies.put(`m/${id}/${msgId}`, bytes);
		await server.deps.db.insert(messages).values({
			mailboxId: id,
			id: msgId,
			sender: a.sigKey,
			size: 8,
			createdAt: now,
			expiresAt: now + DAY_MS,
		});
		const { res } = await postMessage(a, id, { msgId, bytes });
		expect(await res.json()).toEqual({ stored: true, recipients: 2 });
		expect(await inboxIds(b, id)).toEqual([msgId]);
		expect(await inboxIds(c, id)).toEqual([msgId]);
	});
});
