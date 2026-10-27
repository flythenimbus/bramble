// Two devices end to end, for an entry's attachments when one device deletes the entry and the
// other changes it: real EntryMutations and FileMutations on each, syncing through
// applyRemotePayload. See docs/file-attachments.md, "Deleting an entry hides its attachments".

import { describe, expect, it } from "vitest";
import type { Entry, EntryData } from "../hooks/useVault";
import { conflictsOf, type VaultEntries, vaultEntriesFromPayload } from "../vault/entry-mutations";
import { harness } from "../vault/entry-mutations.harness";
import { createFileMutations, type FileSealer } from "../vault/file-mutations";
import { applyRemotePayload, createVaultSyncPort } from "./apply-remote";
import { liveFiles } from "./vault-merge";

const login = (name: string, password = "pw"): EntryData => ({
	type: "login",
	name,
	urls: [],
	username: "u",
	password,
});

/** Seals nothing: these tests route records and never open one. */
function placeholderSealer(): FileSealer {
	let seq = 0;
	return {
		seal: async () => ({
			hash: (++seq).toString(16).padStart(64, "0"),
			size: 32,
			wrappedFek: "wf",
			fekIv: "fi",
			noncePrefix: "np",
			metaBlob: "mb",
			metaIv: "mi",
		}),
		resealMeta: async () => ({ metaBlob: "mb2", metaIv: "mi2" }),
		describe: async () => ({ name: "f", mime: "application/pdf", plaintextSize: 16 }),
	};
}

function device(now: () => number, node: string) {
	const h = harness(now, node);
	const files = createFileMutations({
		sealer: placeholderSealer(),
		persist: h.mutations.persist,
		clock: async () => h.clock,
	});
	return { ...h, files };
}
type Device = ReturnType<typeof device>;

async function load(d: Device): Promise<VaultEntries> {
	const payload = await d.mutations.readEntriesPayload();
	const decrypted = payload.entries.map(
		(e) => ({ id: e.id, ...JSON.parse(e.ciphertext.slice(3)) }) as Entry,
	);
	return vaultEntriesFromPayload(payload, decrypted);
}

/** The attachments a device shows, by name, from what reached its disk. */
async function shownNames(d: Device): Promise<string[]> {
	const payload = await d.mutations.readEntriesPayload();
	const names = new Map((payload.files ?? []).map((f) => [f.id, f.hash]));
	return liveFiles(payload)
		.map((f) => names.get(f.id) as string)
		.sort();
}

async function sync(from: Device, to: Device): Promise<void> {
	const port = createVaultSyncPort({
		store: to.mutations,
		crypto: to.crypto,
		witnessRemote: async (stamps) => {
			for (const s of stamps) to.clock.witness(s);
		},
	});
	await applyRemotePayload(port, await from.mutations.readEntriesPayload());
}

async function both(a: Device, b: Device): Promise<void> {
	await sync(a, b);
	await sync(b, a);
}

const attach = async (d: Device, entryId: string) => {
	const next = await d.files.attach(await load(d), {
		source: { kind: "bytes", bytes: new Uint8Array([1]) },
		name: "scan.pdf",
		mime: "application/pdf",
		entryId,
	});
	return next.manifest?.files?.at(-1)?.hash as string;
};

/** A laptop and a phone sharing one login with one attachment, in sync. */
async function pair() {
	const time = { now: 1000 };
	const laptop = device(() => time.now, "laptop");
	const phone = device(() => time.now, "phone");
	const seeded = await laptop.mutations.add(await load(laptop), login("Passport"));
	const id = seeded.entries[0]!.id;
	const scan = await attach(laptop, id);
	await sync(laptop, phone);
	return { time, laptop, phone, id, scan };
}

describe("two devices: an entry's attachments across a delete", () => {
	it("keeping an entry deleted while it was edited brings its attachments back", async () => {
		const { time, laptop, phone, id, scan } = await pair();
		time.now = 2000;
		await laptop.mutations.remove(await load(laptop), id);
		expect(await shownNames(laptop)).toEqual([]);
		time.now = 3000;
		await phone.mutations.update(await load(phone), id, login("Passport", "renewed"));
		await both(laptop, phone);

		for (const d of [laptop, phone]) {
			expect(conflictsOf(await load(d)).get(id)).toEqual({ versions: 0, deleted: true });
			expect(await shownNames(d)).toEqual([scan]);
		}

		time.now = 4000;
		await laptop.mutations.resolve(await load(laptop), id, { kind: "keep", superseded: [] });
		await both(laptop, phone);
		for (const d of [laptop, phone]) {
			expect(conflictsOf(await load(d)).has(id)).toBe(false);
			expect(await shownNames(d)).toEqual([scan]);
		}
	});

	it("deleting it after all hides the attachments on both", async () => {
		const { time, laptop, phone, id } = await pair();
		time.now = 2000;
		await laptop.mutations.remove(await load(laptop), id);
		time.now = 3000;
		await phone.mutations.update(await load(phone), id, login("Passport", "renewed"));
		await both(laptop, phone);

		time.now = 4000;
		await phone.mutations.remove(await load(phone), id);
		await both(laptop, phone);
		for (const d of [laptop, phone]) {
			expect((await load(d)).entries).toEqual([]);
			expect(await shownNames(d)).toEqual([]);
		}
	});

	it("a file attached where the delete hadn't reached keeps the entry, as a delete conflict", async () => {
		const { time, laptop, phone, id, scan } = await pair();
		time.now = 2000;
		await laptop.mutations.remove(await load(laptop), id);
		time.now = 3000;
		const visa = await attach(phone, id);
		await both(laptop, phone);

		for (const d of [laptop, phone]) {
			const s = await load(d);
			expect(s.entries.map((e) => e.name)).toEqual(["Passport"]);
			expect(conflictsOf(s).get(id)).toEqual({ versions: 0, deleted: true });
			expect(await shownNames(d)).toEqual([scan, visa].sort());
		}

		// Deleting it once its new file is seen takes the file with it.
		time.now = 4000;
		await laptop.mutations.remove(await load(laptop), id);
		await both(laptop, phone);
		for (const d of [laptop, phone]) {
			expect((await load(d)).entries).toEqual([]);
			expect(await shownNames(d)).toEqual([]);
		}
	});

	it("a file attached after the delete arrived can't be, so nothing is left without its entry", async () => {
		const { time, laptop, phone, id } = await pair();
		time.now = 2000;
		await laptop.mutations.remove(await load(laptop), id);
		await sync(laptop, phone);
		await expect(attach(phone, id)).rejects.toThrow(/no longer in the vault/);
	});

	it("a detach still removes the file, whatever happens to its entry", async () => {
		const { time, laptop, phone, id } = await pair();
		const fileId = (await load(phone)).manifest?.files?.[0]?.id as string;
		time.now = 2000;
		await phone.files.detach(await load(phone), fileId);
		await phone.mutations.update(await load(phone), id, login("Passport", "renewed"));
		time.now = 3000;
		await laptop.mutations.remove(await load(laptop), id);
		await both(laptop, phone);

		for (const d of [laptop, phone]) {
			expect(conflictsOf(await load(d)).get(id)).toEqual({ versions: 0, deleted: true });
			expect(await shownNames(d)).toEqual([]);
		}
	});
});
