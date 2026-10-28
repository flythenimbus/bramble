import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	ack,
	activate,
	createMailbox,
	inbox,
	newMessageId,
	postMessage,
	setup,
	uploadBlob,
} from "../test/harness.ts";
import { sweep } from "./sweep.ts";
import { DAY_MS } from "./time.ts";

const HOUR_MS = 3_600_000;
const NOTHING = { messages: 0, blobs: 0, markers: 0, mailboxes: 0, orphans: 0 };

/** A and B active in a mailbox whose retention is 7 days (the ceiling stays 365). */
async function pair() {
	const { server, devices } = await setup(2);
	const [a, b] = [devices[0]!, devices[1]!];
	const id = await createMailbox(a, [b]);
	await activate(id, b);
	expect((await a.request("PATCH", `/v1/mailboxes/${id}`, { retentionDays: 7 })).status).toBe(204);
	return { server, a, b, id };
}

describe("sweep", () => {
	it("expires a message at retention and leaves a marker for each recipient that missed it", async () => {
		const { server, a, b, id } = await pair();
		await postMessage(a, id, { to: [b] });
		await postMessage(a, id, { to: [b] });
		server.clock.now += 7 * DAY_MS;
		expect(await sweep(server.deps)).toEqual({ ...NOTHING, messages: 2 });
		const box = await inbox(b, id);
		expect(box.messages).toEqual([]);
		expect(box.markers).toEqual([
			{ id: expect.any(Number), sender: a.sigKey, count: 2, expiredAt: server.clock.now },
		]);
	});

	it("keeps a message one millisecond before it expires", async () => {
		const { server, a, b, id } = await pair();
		const { msgId } = await postMessage(a, id, { to: [b] });
		server.clock.now += 7 * DAY_MS - 1;
		expect(await sweep(server.deps)).toEqual(NOTHING);
		expect((await inbox(b, id)).messages.map((m) => m.id)).toEqual([msgId]);
	});

	it("adds to an existing marker rather than starting another", async () => {
		const { server, a, b, id } = await pair();
		await postMessage(a, id, { to: [b] });
		server.clock.now += 7 * DAY_MS;
		await sweep(server.deps);
		await postMessage(a, id, { to: [b] });
		server.clock.now += 7 * DAY_MS;
		await sweep(server.deps);
		expect((await inbox(b, id)).markers.map((m) => m.count)).toEqual([2]);
	});

	it("deletes a marker once its member acknowledges it, and old markers on their own", async () => {
		const { server, a, b, id } = await pair();
		await postMessage(a, id, { to: [b] });
		server.clock.now += 7 * DAY_MS;
		await sweep(server.deps);
		const [marker] = (await inbox(b, id)).markers;
		await ack(b, id, { markers: [marker!.id] });
		expect((await inbox(b, id)).markers).toEqual([]);

		await postMessage(a, id, { to: [b] });
		server.clock.now += 7 * DAY_MS;
		await sweep(server.deps);
		server.clock.now += 365 * DAY_MS + 1;
		await inbox(a, id); // a check-in keeps the mailbox from being abandoned
		expect(await sweep(server.deps)).toEqual({ ...NOTHING, markers: 1 });
		expect((await inbox(b, id)).markers).toEqual([]);
	});

	it("expires blobs without leaving markers", async () => {
		const { server, a, b, id } = await pair();
		const { hash } = await uploadBlob(a, id, randomBytes(64));
		server.clock.now += 7 * DAY_MS;
		expect(await sweep(server.deps)).toEqual({ ...NOTHING, blobs: 1 });
		const box = await inbox(b, id);
		expect(box.blobs).toEqual([]);
		expect(box.markers).toEqual([]);
		expect((await b.request("GET", `/v1/mailboxes/${id}/blobs/${hash}`)).status).toBe(404);
	});

	it("deletes a mailbox nobody has checked in to for the ceiling, bodies included", async () => {
		const { server, a, b, id } = await pair();
		await postMessage(a, id, { to: [b] });
		server.clock.now += 365 * DAY_MS + 1;
		const report = await sweep(server.deps);
		expect(report.mailboxes).toBe(1);
		expect((await a.request("GET", `/v1/mailboxes/${id}/members`)).status).toBe(404);
		let n = 0;
		for await (const _ of server.deps.bodies.keys()) n++;
		expect(n).toBe(0);
	});

	it("keeps a mailbox someone checked in to within the ceiling", async () => {
		const { server, a, b, id } = await pair();
		server.clock.now += 300 * DAY_MS;
		await inbox(b, id);
		server.clock.now += 100 * DAY_MS;
		expect((await sweep(server.deps)).mailboxes).toBe(0);
		expect((await a.request("GET", `/v1/mailboxes/${id}/members`)).status).toBe(200);
	});

	it("keeps a recent orphan body and deletes an old one", async () => {
		const { server, id } = await pair();
		await server.deps.bodies.put(`m/${id}/${newMessageId()}`, new Uint8Array([1]));
		expect((await sweep(server.deps)).orphans).toBe(0);
		server.clock.now += HOUR_MS + 1;
		expect((await sweep(server.deps)).orphans).toBe(1);
	});

	it("is a no-op the second time", async () => {
		const { server, a, b, id } = await pair();
		await postMessage(a, id, { to: [b] });
		await uploadBlob(a, id, randomBytes(32));
		server.clock.now += 7 * DAY_MS;
		await sweep(server.deps);
		expect(await sweep(server.deps)).toEqual(NOTHING);
	});
});
