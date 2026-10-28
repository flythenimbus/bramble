import { randomBytes } from "node:crypto";
import {
	INBOX_PAGE,
	InboxResponseSchema,
	MAX_BLOB_BYTES,
	PostResponseSchema,
} from "@vault/core/src/sync/mailbox/protocol.ts";
import { describe, expect, it } from "vitest";
import { ack, activate, createMailbox, inbox, setup, uploadBlob } from "../test/harness.ts";

async function trio() {
	const { server, devices } = await setup(3);
	const [a, b, c] = [devices[0]!, devices[1]!, devices[2]!];
	const id = await createMailbox(a, [b, c]);
	await activate(id, b, c);
	return { server, a, b, c, id };
}

const blobHashes = async (...args: Parameters<typeof inbox>) =>
	(await inbox(...args)).blobs.map((blob) => blob.hash);

async function bodyCount(server: Awaited<ReturnType<typeof trio>>["server"]) {
	let n = 0;
	for await (const _ of server.deps.bodies.keys()) n++;
	return n;
}

describe("blobs", () => {
	it("stores a blob once and delivers it to every other active member", async () => {
		const { a, b, c, id } = await trio();
		const bytes = randomBytes(4096);
		const { res, hash } = await uploadBlob(a, id, bytes);
		expect(PostResponseSchema.parse(await res.json())).toEqual({ stored: true, recipients: 2 });
		expect(await blobHashes(b, id)).toEqual([hash]);
		expect(await blobHashes(c, id)).toEqual([hash]);
		expect(await blobHashes(a, id)).toEqual([]);
		const got = await b.request("GET", `/v1/mailboxes/${id}/blobs/${hash}`);
		expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array(bytes));
	});

	it("refuses bytes that do not match the hash, and keeps nothing", async () => {
		const { server, a, b, id } = await trio();
		const { res, hash } = await uploadBlob(a, id, randomBytes(64), { sendBytes: randomBytes(64) });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "hash_mismatch" });
		expect((await b.request("GET", `/v1/mailboxes/${id}/blobs/${hash}`)).status).toBe(404);
		expect(await bodyCount(server)).toBe(0);
	});

	it("refuses a declared length over MAX_BLOB_BYTES without reading the body", async () => {
		const { a, id } = await trio();
		const { res } = await uploadBlob(a, id, randomBytes(16), {
			headers: { "content-length": String(MAX_BLOB_BYTES + 1) },
		});
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "too_large" });
	});

	it("refuses a path-shaped or upper-case hash", async () => {
		const { a, id } = await trio();
		for (const bad of ["A".repeat(64), "0".repeat(63), "0".repeat(64).replace(/^0/, "/")]) {
			const res = await a.request("GET", `/v1/mailboxes/${id}/blobs/${encodeURIComponent(bad)}`);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "bad_request" });
		}
		// URL parsing resolves a dot segment before routing, so the path no longer matches what was
		// signed: refused before any route or storage sees it.
		expect((await a.request("GET", `/v1/mailboxes/${id}/blobs/..`)).status).toBe(401);
	});

	it("tells holders what others want, and forgets a want once the blob arrives", async () => {
		const { a, b, id } = await trio();
		const bytes = randomBytes(256);
		const hash = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
		expect((await b.request("PUT", `/v1/mailboxes/${id}/wants`, { hashes: [hash] })).status).toBe(
			204,
		);
		expect((await inbox(a, id)).wanted).toEqual([hash]);
		expect((await inbox(b, id)).wanted).toEqual([]);
		await uploadBlob(a, id, bytes);
		expect((await inbox(a, id)).wanted).toEqual([]);
		expect(await blobHashes(b, id)).toEqual([hash]);
	});

	it("pages what others want apart from what the caller must collect", async () => {
		const { b, c, id } = await trio();
		const hashes = Array.from({ length: INBOX_PAGE + 1 }, () =>
			randomBytes(32).toString("hex"),
		).sort();
		expect((await b.request("PUT", `/v1/mailboxes/${id}/wants`, { hashes })).status).toBe(204);
		const first = await inbox(c, id);
		expect(first.more).toBe(false);
		expect(first.wanted).toEqual(hashes.slice(0, INBOX_PAGE));
		expect(first.wantedMore).toBe(true);
		const res = await c.request(
			"GET",
			`/v1/mailboxes/${id}/inbox?wantedAfter=${first.wanted.at(-1)}`,
		);
		const next = InboxResponseSchema.parse(await res.json());
		expect(next.wanted).toEqual(hashes.slice(INBOX_PAGE));
		expect(next.wantedMore).toBe(false);
	});

	it("deletes the blob after its last recipient acknowledges it", async () => {
		const { server, a, b, c, id } = await trio();
		const { hash } = await uploadBlob(a, id, randomBytes(128));
		await ack(b, id, { blobs: [hash] });
		expect((await c.request("GET", `/v1/mailboxes/${id}/blobs/${hash}`)).status).toBe(200);
		await ack(c, id, { blobs: [hash] });
		expect((await c.request("GET", `/v1/mailboxes/${id}/blobs/${hash}`)).status).toBe(404);
		expect(await bodyCount(server)).toBe(0);
		expect((await inbox(a, id)).usedBytes).toBe(0);
	});

	it("answers a re-upload of a present hash without storing it again", async () => {
		const { server, a, b, id } = await trio();
		const bytes = randomBytes(512);
		await uploadBlob(a, id, bytes);
		const { res } = await uploadBlob(b, id, bytes);
		expect(await res.json()).toEqual({ stored: true, recipients: 2 });
		expect(await bodyCount(server)).toBe(1);
	});

	it("stores nothing when no other member is active", async () => {
		const { server, devices } = await setup(1);
		const a = devices[0]!;
		const id = await createMailbox(a);
		const { res } = await uploadBlob(a, id, randomBytes(32));
		expect(await res.json()).toEqual({ stored: false, recipients: 0 });
		let n = 0;
		for await (const _ of server.deps.bodies.keys()) n++;
		expect(n).toBe(0);
	});
});
