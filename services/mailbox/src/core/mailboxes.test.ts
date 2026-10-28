import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createMailbox, memberStatuses, newMailboxId, setup } from "../test/harness.ts";
import { mailboxes } from "./schema.ts";

describe("mailboxes", () => {
	it("creates a mailbox with the caller active and everyone else eligible", async () => {
		const {
			devices: [a, b, c],
		} = await setup(3);
		const id = await createMailbox(a!, [b!, c!]);
		expect(await memberStatuses(b!, id)).toEqual({
			[a!.sigKey]: "active",
			[b!.sigKey]: "eligible",
			[c!.sigKey]: "eligible",
		});
	});

	it("refuses to create a mailbox that does not list its creator", async () => {
		const {
			devices: [a, b],
		} = await setup(2);
		const res = await a!.request("POST", `/v1/mailboxes/${newMailboxId()}`, {
			members: [b!.sigKey],
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "bad_request" });
	});

	it("answers 409 for an id that already exists", async () => {
		const {
			devices: [a, b],
		} = await setup(2);
		const id = await createMailbox(a!, [b!]);
		const res = await b!.request("POST", `/v1/mailboxes/${id}`, { members: [b!.sigKey] });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "exists" });
	});

	it("clamps retention to the server's ceiling", async () => {
		const {
			server,
			devices: [a],
		} = await setup(1, { retentionMaxDays: 30 });
		const id = newMailboxId();
		await a!.request("POST", `/v1/mailboxes/${id}`, { members: [a!.sigKey], retentionDays: 365 });
		const row = () => server.deps.db.select().from(mailboxes).where(eq(mailboxes.id, id)).get();
		expect((await row())?.retentionDays).toBe(30);
		expect((await a!.request("PATCH", `/v1/mailboxes/${id}`, { retentionDays: 90 })).status).toBe(
			204,
		);
		expect((await row())?.retentionDays).toBe(30);
		await a!.request("PATCH", `/v1/mailboxes/${id}`, { retentionDays: 7 });
		expect((await row())?.retentionDays).toBe(7);
	});

	it("refuses a malformed mailbox id before touching storage", async () => {
		const {
			devices: [a],
		} = await setup(1);
		const res = await a!.request("POST", "/v1/mailboxes/not-a-mailbox-id", {
			members: [a!.sigKey],
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "bad_request" });
	});

	it("answers 404 for a mailbox that does not exist and 403 to a stranger", async () => {
		const {
			devices: [a, stranger],
		} = await setup(2);
		expect((await a!.request("GET", `/v1/mailboxes/${newMailboxId()}/members`)).status).toBe(404);
		const id = await createMailbox(a!);
		const res = await stranger!.request("GET", `/v1/mailboxes/${id}/members`);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "not_member" });
	});
});

describe("membership", () => {
	it("lets an eligible device activate, and refuses a stranger", async () => {
		const {
			devices: [a, b, stranger],
		} = await setup(3);
		const id = await createMailbox(a!, [b!]);
		expect(
			(await b!.request("POST", `/v1/mailboxes/${id}/activation`, { active: true })).status,
		).toBe(200);
		expect((await memberStatuses(a!, id))[b!.sigKey]).toBe("active");
		const res = await stranger!.request("POST", `/v1/mailboxes/${id}/activation`, { active: true });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "not_eligible" });
	});

	it("only lets active members change the list", async () => {
		const {
			devices: [a, b, c],
		} = await setup(3);
		const id = await createMailbox(a!, [b!]);
		const res = await b!.request("POST", `/v1/mailboxes/${id}/members`, { add: [c!.sigKey] });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "not_active" });
		expect(
			(await a!.request("POST", `/v1/mailboxes/${id}/members`, { add: [c!.sigKey] })).status,
		).toBe(200);
		expect((await memberStatuses(a!, id))[c!.sigKey]).toBe("eligible");
	});

	it("leaves an existing member's status alone when it is added again", async () => {
		const {
			devices: [a, b],
		} = await setup(2);
		const id = await createMailbox(a!, [b!]);
		await b!.request("POST", `/v1/mailboxes/${id}/activation`, { active: true });
		await a!.request("POST", `/v1/mailboxes/${id}/members`, { add: [b!.sigKey] });
		expect((await memberStatuses(a!, id))[b!.sigKey]).toBe("active");
	});

	it("a removed device cannot make itself eligible again", async () => {
		const {
			devices: [a, b],
		} = await setup(2);
		const id = await createMailbox(a!, [b!]);
		await b!.request("POST", `/v1/mailboxes/${id}/activation`, { active: true });
		expect(
			(await a!.request("POST", `/v1/mailboxes/${id}/members`, { remove: [b!.sigKey] })).status,
		).toBe(200);
		const readd = await b!.request("POST", `/v1/mailboxes/${id}/members`, { add: [b!.sigKey] });
		expect(readd.status).toBe(403);
		expect(await readd.json()).toEqual({ error: "not_member" });
		const reactivate = await b!.request("POST", `/v1/mailboxes/${id}/activation`, { active: true });
		expect(reactivate.status).toBe(403);
		expect(await reactivate.json()).toEqual({ error: "not_eligible" });
	});

	it("deactivating keeps the member eligible", async () => {
		const {
			devices: [a, b],
		} = await setup(2);
		const id = await createMailbox(a!, [b!]);
		await b!.request("POST", `/v1/mailboxes/${id}/activation`, { active: true });
		expect(
			(await b!.request("POST", `/v1/mailboxes/${id}/activation`, { active: false })).status,
		).toBe(200);
		expect((await memberStatuses(a!, id))[b!.sigKey]).toBe("eligible");
	});
});
