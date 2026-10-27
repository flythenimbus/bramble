import { describe, expect, it } from "vitest";
import { liveFiles } from "../sync/vault-merge";
import { emptyEntries as empty, loginEntry as login } from "../test/vault-fixtures";
import { harness as entryHarness } from "./entry-mutations.harness";
import {
	createFileMutations,
	decodeFileMeta,
	encodeFileMeta,
	FILE_CHUNK_LEN,
	type FileSealer,
	type FileSource,
	plaintextSize,
	sealAttachment,
} from "./file-mutations";

const te = new TextEncoder();
const _td = new TextDecoder();

const bytes = (s: string): FileSource => ({ kind: "bytes", bytes: te.encode(s) });

/** Deterministic stand-in for the platform sealer: hashes by content so distinct files get
 * distinct addresses, and keeps metadata in a lookup rather than really encrypting it. */
function fakeSealer() {
	const meta = new Map<string, { name: string; mime: string; plaintextSize: number }>();
	let seq = 0;
	const hashFor = (n: number) => n.toString(16).padStart(64, "0");
	const sealer: FileSealer = {
		seal: async (source, m) => {
			const hash = hashFor(++seq);
			const size = source.kind === "bytes" ? source.bytes.length + 16 : 16;
			meta.set(hash, { ...m, plaintextSize: size - 16 });
			return {
				hash,
				size,
				wrappedFek: `wf-${seq}`,
				fekIv: `fi-${seq}`,
				noncePrefix: `np-${seq}`,
				metaBlob: `mb-${seq}`,
				metaIv: `mi-${seq}`,
			};
		},
		resealMeta: async (record, m) => {
			const prev = meta.get(record.hash);
			meta.set(record.hash, { ...m, plaintextSize: prev?.plaintextSize ?? 0 });
			return { metaBlob: `mb2-${m.name}`, metaIv: "mi2" };
		},
		describe: async (record) => {
			const found = meta.get(record.hash);
			if (!found) throw new Error(`no metadata for ${record.hash}`);
			return found;
		},
	};
	return sealer;
}

function harness(now: () => number = () => 1000) {
	const { mutations: entries, clock, writes } = entryHarness(now);
	const files = createFileMutations({
		sealer: fakeSealer(),
		persist: entries.persist,
		clock: async () => clock,
	});
	return { entries, files, writes };
}

/** What actually reached the disk, so nothing here can pass on in-memory state alone. */
async function onDisk(h: ReturnType<typeof harness>) {
	const payload = await h.entries.readEntriesPayload();
	return {
		files: payload.files ?? [],
		tombstones: payload.fileTombstones ?? [],
		cascades: payload.fileCascades ?? [],
		shown: liveFiles(payload),
	};
}

describe("createFileMutations: attach", () => {
	// A sync can take the entry while its page is open; a file attached to it would show nowhere.
	it("refuses an entry the vault no longer holds, and writes nothing", async () => {
		const h = harness();
		const state = await h.entries.add(empty(), login("airline"));
		const before = h.writes();
		await expect(
			h.files.attach(state, {
				source: bytes("passport"),
				name: "passport.pdf",
				mime: "application/pdf",
				entryId: "gone",
			}),
		).rejects.toThrow(/no longer in the vault/);
		expect(h.writes()).toBe(before);
	});

	it("stamps a record, writes it, and links it to an entry", async () => {
		const h = harness();
		const withEntry = await h.entries.add(empty(), login("airline"));
		const entryId = withEntry.entries[0]?.id as string;
		const next = await h.files.attach(withEntry, {
			source: bytes("passport"),
			name: "passport.pdf",
			mime: "application/pdf",
			entryId,
		});

		const record = next.manifest?.files?.[0];
		expect(record?.entryId).toBe(entryId);
		expect(record?.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(record?.size).toBe(24);
		expect(record?.hlc.node).toBe("device-a");
		expect((await onDisk(h)).files).toEqual(next.manifest?.files);
	});

	it("omits entryId for a standalone Files item", async () => {
		const h = harness();
		const next = await h.files.attach(empty(), {
			source: bytes("deed"),
			name: "house-deed.pdf",
			mime: "application/pdf",
		});
		expect(next.manifest?.files?.[0]).not.toHaveProperty("entryId");
	});

	it("leaves entries and settings untouched", async () => {
		const h = harness();
		const start = await h.entries.add(empty(), login("a"));
		const withSetting = await h.entries.setSetting(start, "pref.theme", "dark");
		const next = await h.files.attach(withSetting, {
			source: bytes("x"),
			name: "x.txt",
			mime: "text/plain",
		});
		const payload = await h.entries.readEntriesPayload();
		expect(payload.entries).toHaveLength(1);
		expect(payload.settings?.["pref.theme"]?.value).toBe("dark");
		expect(next.entries).toHaveLength(1);
	});

	it("accumulates several attachments", async () => {
		const h = harness();
		let state = empty();
		for (const name of ["a.pdf", "b.pdf", "c.pdf"]) {
			state = await h.files.attach(state, { source: bytes(name), name, mime: "application/pdf" });
		}
		expect((await onDisk(h)).files).toHaveLength(3);
		// Distinct content gets distinct addresses: no dedup, by design.
		expect(new Set(state.manifest?.files?.map((f) => f.hash)).size).toBe(3);
	});

	it("rejects an empty, overlong, control-character or bidi-override name", async () => {
		const h = harness();
		const bad = [
			"",
			"   ",
			"a".repeat(256),
			"re\u0000port.pdf",
			"in\nvoice.pdf",
			"ab\u202epdf.exe",
		];
		for (const name of bad) {
			await expect(
				h.files.attach(empty(), { source: bytes("x"), name, mime: "text/plain" }),
			).rejects.toThrow();
		}
		expect(h.writes()).toBe(0);
	});
});

describe("createFileMutations: detach and rename", () => {
	it("detach drops the record and keeps a stamped tombstone", async () => {
		const h = harness();
		const attached = await h.files.attach(empty(), {
			source: bytes("x"),
			name: "x.pdf",
			mime: "application/pdf",
		});
		const fileId = attached.manifest?.files?.[0]?.id as string;
		const next = await h.files.detach(attached, fileId);

		expect(next.manifest?.files ?? []).toEqual([]);
		const disk = await onDisk(h);
		expect(disk.files).toEqual([]);
		// The graveyard is what stops a stale peer re-adding it on the next gossip round.
		expect(disk.tombstones.map((t) => t.id)).toEqual([fileId]);
	});

	it("detaching an unknown id does not rewrite the vault", async () => {
		const h = harness();
		const attached = await h.files.attach(empty(), {
			source: bytes("x"),
			name: "x.pdf",
			mime: "application/pdf",
		});
		const before = h.writes();
		expect(await h.files.detach(attached, "nope")).toBe(attached);
		expect(h.writes()).toBe(before);
	});

	it("rename reseals the metadata and restamps, without moving bytes", async () => {
		const h = harness(() => 2000);
		const attached = await h.files.attach(empty(), {
			source: bytes("x"),
			name: "old.pdf",
			mime: "application/pdf",
		});
		const before = attached.manifest?.files?.[0];
		const next = await h.files.rename(attached, before?.id as string, "new.pdf");
		const after = next.manifest?.files?.[0];

		expect(after?.hash).toBe(before?.hash); // same blob
		expect(after?.size).toBe(before?.size);
		expect(after?.metaBlob).not.toBe(before?.metaBlob); // resealed
		expect(after?.hlc.counter).toBeGreaterThan(before?.hlc.counter as number);
	});

	// A no-op rename must not rewrite: every write re-encrypts every entry in the vault.
	it("renaming to the same name does not rewrite the vault", async () => {
		const h = harness();
		const attached = await h.files.attach(empty(), {
			source: bytes("x"),
			name: "same.pdf",
			mime: "application/pdf",
		});
		const before = h.writes();
		const result = await h.files.rename(
			attached,
			attached.manifest?.files?.[0]?.id as string,
			"same.pdf",
		);
		expect(result).toBe(attached);
		expect(h.writes()).toBe(before);
	});

	it("renaming an unknown id is a no-op", async () => {
		const h = harness();
		const state = await h.files.attach(empty(), {
			source: bytes("x"),
			name: "x.pdf",
			mime: "application/pdf",
		});
		expect(await h.files.rename(state, "nope", "y.pdf")).toBe(state);
	});
});

describe("deleting an entry takes its attachments", () => {
	it("marks the deleted entry's files, hides them, and spares everything else", async () => {
		const h = harness();
		let state = await h.entries.add(empty(), login("airline"));
		state = await h.entries.add(state, login("bank"));
		const [airline, bank] = state.entries.map((e) => e.id) as [string, string];

		state = await h.files.attach(state, {
			source: bytes("boarding"),
			name: "boarding.pdf",
			mime: "application/pdf",
			entryId: airline,
		});
		state = await h.files.attach(state, {
			source: bytes("statement"),
			name: "statement.pdf",
			mime: "application/pdf",
			entryId: bank,
		});
		state = await h.files.attach(state, {
			source: bytes("deed"),
			name: "deed.pdf",
			mime: "application/pdf",
		});
		const doomedFile = state.manifest?.files?.find((f) => f.entryId === airline)?.id;

		const after = await h.entries.remove(state, airline);
		const disk = await onDisk(h);
		expect(disk.cascades.map((t) => t.id)).toEqual([doomedFile]);
		expect(disk.tombstones).toEqual([]);
		// The record stays, for an entry kept from a delete conflict; only the others show.
		expect(disk.files.map((f) => f.entryId)).toEqual([airline, bank, undefined]);
		expect(disk.shown.map((f) => f.entryId)).toEqual([bank, undefined]);
		expect(after.entries.map((e) => e.id)).toEqual([bank]);
	});

	it("leaves the manifest alone when the deleted entry had no attachments", async () => {
		const h = harness();
		let state = await h.entries.add(empty(), login("a"));
		state = await h.files.attach(state, {
			source: bytes("deed"),
			name: "deed.pdf",
			mime: "application/pdf",
		});
		const manifestBefore = state.manifest;
		const after = await h.entries.remove(state, state.entries[0]?.id as string);
		expect(after.manifest).toBe(manifestBefore);
		expect((await onDisk(h)).cascades).toEqual([]);
	});

	it("a vault with no files is unaffected by a delete", async () => {
		const h = harness();
		const state = await h.entries.add(empty(), login("a"));
		const after = await h.entries.remove(state, state.entries[0]?.id as string);
		expect(after.manifest).toBeUndefined();
		const payload = await h.entries.readEntriesPayload();
		expect(payload).not.toHaveProperty("files");
		expect(payload).not.toHaveProperty("fileTombstones");
		expect(payload).not.toHaveProperty("fileCascades");
	});
});

describe("createFileMutations: the attachment size limit", () => {
	// Refused before anything is sealed: an attachment no backup could carry would be listed
	// forever and left out of every one.
	it("refuses a file over the limit, before sealing or writing anything", async () => {
		const { AttachmentTooLargeError } = await import("./file-mutations");
		const { MAX_ATTACHMENT_BYTES } = await import("../backup/archive");
		const h = harness();
		const big = { size: MAX_ATTACHMENT_BYTES + 1 } as Blob;
		await expect(
			h.files.attach(empty(), {
				source: { kind: "blob", blob: big },
				name: "huge.mov",
				mime: "video/quicktime",
			}),
		).rejects.toBeInstanceOf(AttachmentTooLargeError);
		expect(h.writes()).toBe(0);
	});

	it("accepts a file exactly at the limit", async () => {
		const { MAX_ATTACHMENT_BYTES } = await import("../backup/archive");
		const h = harness();
		const edge = { size: MAX_ATTACHMENT_BYTES } as Blob;
		const next = await h.files.attach(empty(), {
			source: { kind: "blob", blob: edge },
			name: "edge.bin",
			mime: "application/octet-stream",
		});
		expect(next.manifest?.files).toHaveLength(1);
	});
});

describe("file metadata", () => {
	it("round-trips name and type, and nothing else", () => {
		const meta = { name: "passport.pdf", mime: "application/pdf" };
		expect(decodeFileMeta(encodeFileMeta({ ...meta, extra: 1 } as typeof meta))).toEqual(meta);
		expect(JSON.parse(encodeFileMeta(meta))).toEqual(meta);
	});

	it("refuses metadata that is not what it writes", () => {
		expect(() => decodeFileMeta(JSON.stringify({ name: "x" }))).toThrow(/malformed/);
		expect(() => decodeFileMeta(JSON.stringify({ name: 1, mime: "a/b" }))).toThrow(/malformed/);
	});
});

describe("plaintextSize", () => {
	it("takes one tag per chunk off, at every boundary", () => {
		const tag = 16;
		for (const plain of [
			0,
			1,
			FILE_CHUNK_LEN - 1,
			FILE_CHUNK_LEN,
			FILE_CHUNK_LEN + 1,
			3 * FILE_CHUNK_LEN,
		]) {
			const chunks = Math.max(1, Math.ceil(plain / FILE_CHUNK_LEN));
			expect(plaintextSize(plain + chunks * tag)).toBe(plain);
		}
	});
});

// A KeePass import brings files with its entries. One write for all of it, so the import lands
// whole or not at all, and a re-import can hang files on entries the vault already has.
describe("importing entries with their files", () => {
	it("writes the entries and their files in one write, onto new and existing entries", async () => {
		const h = harness();
		const start = await h.entries.add(empty(), login("already here"));
		const existingId = start.entries[0]?.id as string;
		const sealer = fakeSealer();
		const forNew = await sealAttachment(sealer, {
			source: bytes("scan"),
			name: "scan.pdf",
			mime: "x/y",
		});
		const forOld = await sealAttachment(sealer, {
			source: bytes("note"),
			name: "note.txt",
			mime: "x/y",
		});
		const writes = h.writes();

		const next = await h.entries.importMany(
			start,
			[login("new one")],
			[
				{ sealed: forNew, item: 0 },
				{ sealed: forOld, entryId: existingId },
			],
		);

		expect(h.writes()).toBe(writes + 1);
		const added = next.entries.find((e) => e.name === "new one")?.id;
		expect(next.manifest?.files?.map((f) => f.entryId)).toEqual([added, existingId]);
		expect((await onDisk(h)).files.map((f) => f.hash)).toEqual([forNew.hash, forOld.hash]);
	});

	it("refuses a batch with a file that has nowhere to go, and writes nothing", async () => {
		const h = harness();
		const sealed = await sealAttachment(fakeSealer(), {
			source: bytes("x"),
			name: "x.pdf",
			mime: "x/y",
		});
		await expect(
			h.entries.importMany(empty(), [login("x")], [{ sealed, entryId: "not-in-the-vault" }]),
		).rejects.toThrow(/not in the vault/);
		expect(h.writes()).toBe(0);
	});
});
