import { unzipSync, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import type { EntriesPayload, FileRecord } from "../sync/entries-payload";
import { memoryBlobStore, sameBytes } from "../test/memory-blob-store";
import { fileRecord, testVaultBytes } from "../test/vault-fixtures";
import { base64ToBytes } from "../util/bytes";
import {
	type AttachmentListCache,
	BackupArchiveError,
	BackupIncompleteError,
	backupFingerprint,
	buildBackup,
	isBackupArchive,
	openBackup,
	planBackup,
	restoreAttachments,
	VAULT_ENTRY,
} from "./archive";
import { sha256Hex } from "./sigv4";
import { bytesSource, crc32, layoutZip, type RandomAccessSource } from "./zip";

const te = new TextEncoder();
const td = new TextDecoder();
const fill = (n: number, b: number) => Uint8Array.from({ length: n }, (_, i) => (b + i * 7) & 0xff);

/** A vault whose "ciphertext" is the payload's plain JSON, opened by `decrypt` below. The
 * archive code only needs the payload's attachment list; real sealing is tested elsewhere. */
function vaultWith(payload: EntriesPayload): Uint8Array {
	return testVaultBytes(te.encode(JSON.stringify(payload)));
}
const decrypt = vi.fn(async (_iv: string, ciphertext: string) =>
	td.decode(base64ToBytes(ciphertext)),
);
const wrongKey = async () => {
	throw new Error("aes decrypt: aead::Error");
};

/** A sealed attachment, and the manifest record naming it. */
async function sealed(seed: number, len = 64) {
	const bytes = fill(len, seed);
	const hash = await sha256Hex(bytes);
	const record = fileRecord({
		id: `f${seed}`,
		hlc: { wall: seed, counter: 0, node: "n" },
		hash,
		size: len,
	});
	return { bytes, hash, record };
}

const payload = (
	files: FileRecord[] = [],
	fileTombstones: EntriesPayload["fileTombstones"] = [],
) => ({
	entries: [],
	tombstones: [],
	...(files.length ? { files } : {}),
	...(fileTombstones?.length ? { fileTombstones } : {}),
});

const readWhole = (src: RandomAccessSource) => src.read(0, src.size);

/** Byte equality without vitest's deep diff, which crawls on megabytes. */

function memoryCache(): AttachmentListCache & {
	value: { vaultHash: string; hashes: string[] } | null;
} {
	const cache = {
		value: null as { vaultHash: string; hashes: string[] } | null,
		get: async () => cache.value,
		set: async (v: { vaultHash: string; hashes: string[] }) => {
			cache.value = v;
		},
	};
	return cache;
}

describe("a vault without attachments is backed up exactly as before", () => {
	it("is the vault's own bytes, fingerprinted by the hash targets already store", async () => {
		const vault = vaultWith(payload());
		const { store } = memoryBlobStore();
		const built = await buildBackup({ vault, blobs: store, decryptWithVek: decrypt });
		expect(await readWhole(built.body)).toEqual(vault);
		expect(built.fingerprint).toBe(await sha256Hex(vault));
		expect(built.attachments).toBe(0);
	});

	it("does not even decrypt where the platform holds no attachments", async () => {
		decrypt.mockClear();
		const vault = vaultWith(payload());
		const built = await buildBackup({ vault, blobs: null, decryptWithVek: decrypt });
		expect(await readWhole(built.body)).toEqual(vault);
		expect(decrypt).not.toHaveBeenCalled();
	});
});

describe("a vault with attachments becomes one self-contained archive", () => {
	it("packs the vault and every attachment, and reads back byte for byte", async () => {
		const a = await sealed(1);
		const b = await sealed(2, 3 * 1024 * 1024 + 17); // several read chunks
		const { store } = memoryBlobStore();
		await store.put(a.hash, a.bytes);
		await store.put(b.hash, b.bytes);
		const vault = vaultWith(payload([a.record, b.record]));

		const built = await buildBackup({ vault, blobs: store, decryptWithVek: decrypt });
		expect(built.attachments).toBe(2);
		const file = await readWhole(built.body);

		const opened = await openBackup(bytesSource(file));
		expect(opened.kind).toBe("archive");
		expect(opened.vault).toEqual(vault);
		if (opened.kind !== "archive") return;
		const restoredInto = memoryBlobStore().store;
		await restoreAttachments(restoredInto, bytesSource(file), opened.attachments);
		expect(await restoredInto.read(a.hash)).toEqual(a.bytes);
		expect(sameBytes(await restoredInto.read(b.hash), b.bytes)).toBe(true);
	});

	// Anyone can rename a backup to .zip and look inside, so it must be a ZIP other tools read.
	it("is a ZIP another reader agrees with, CRCs included", async () => {
		const a = await sealed(3);
		const { store } = memoryBlobStore();
		await store.put(a.hash, a.bytes);
		const vault = vaultWith(payload([a.record]));
		const built = await buildBackup({ vault, blobs: store, decryptWithVek: decrypt });
		const unzipped = unzipSync(await readWhole(built.body));
		expect(Object.keys(unzipped).sort()).toEqual([`blobs/${a.hash}`, VAULT_ENTRY].sort());
		expect(unzipped[VAULT_ENTRY]).toEqual(vault);
		expect(unzipped[`blobs/${a.hash}`]).toEqual(a.bytes);
	});

	it("reads any range exactly as the whole file has it", async () => {
		const a = await sealed(4, 2 * 1024 * 1024 + 5);
		const { store } = memoryBlobStore();
		await store.put(a.hash, a.bytes);
		const built = await buildBackup({
			vault: vaultWith(payload([a.record])),
			blobs: store,
			decryptWithVek: decrypt,
		});
		const whole = await readWhole(built.body);
		for (const [offset, length] of [
			[0, 10],
			[25, 200],
			[1024 * 1024 - 3, 9],
			[whole.length - 30, 30],
			[7, whole.length - 7],
		] as const) {
			expect(
				sameBytes(await built.body.read(offset, length), whole.subarray(offset, offset + length)),
			).toBe(true);
		}
		await expect(built.body.read(whole.length - 1, 2)).rejects.toThrow();
	});

	it("packs identical content to identical bytes", async () => {
		const a = await sealed(5);
		const { store } = memoryBlobStore();
		await store.put(a.hash, a.bytes);
		const vault = vaultWith(payload([a.record]));
		const one = await buildBackup({ vault, blobs: store, decryptWithVek: decrypt });
		const two = await buildBackup({ vault, blobs: store, decryptWithVek: decrypt });
		expect(sameBytes(await readWhole(one.body), await readWhole(two.body))).toBe(true);
	});

	it("leaves out an attachment that has been deleted, even if its file is still held", async () => {
		const a = await sealed(6);
		const gone = await sealed(7);
		const { store } = memoryBlobStore();
		await store.put(a.hash, a.bytes);
		await store.put(gone.hash, gone.bytes);
		const vault = vaultWith(
			payload(
				[a.record, gone.record],
				[{ id: gone.record.id, hlc: { wall: 99, counter: 0, node: "n" } }],
			),
		);
		const built = await buildBackup({ vault, blobs: store, decryptWithVek: decrypt });
		expect(built.attachments).toBe(1);
		const opened = await openBackup(built.body);
		expect(opened.kind === "archive" && opened.attachments.map((x) => x.hash)).toEqual([a.hash]);
	});
});

describe("a backup is whole or it is not made", () => {
	it("is refused, never partial, when an attachment is not on this device", async () => {
		const a = await sealed(8);
		const absent = await sealed(9);
		const { store } = memoryBlobStore();
		await store.put(a.hash, a.bytes);
		const vault = vaultWith(payload([a.record, absent.record]));

		const plan = await planBackup({ vault, blobs: store, decryptWithVek: decrypt });
		expect(plan.blocked).toEqual({ reason: "missing", count: 1 });
		await expect(plan.body()).rejects.toBeInstanceOf(BackupIncompleteError);
		await expect(buildBackup({ vault, blobs: store, decryptWithVek: decrypt })).rejects.toEqual(
			new BackupIncompleteError({ reason: "missing", count: 1 }),
		);
	});

	// An empty store says nothing about a vault whose list is sealed: its records may name
	// files this device never received. Guessing "no attachments" would upload a backup missing
	// them, so a locked vault with no list in hand waits.
	it("waits for an unlock when the list cannot be read, even with nothing stored", async () => {
		const absent = await sealed(10);
		const vault = vaultWith(payload([absent.record]));
		const { store } = memoryBlobStore();
		const plan = await planBackup({ vault, blobs: store, decryptWithVek: wrongKey });
		expect(plan.blocked).toEqual({ reason: "locked" });
		await expect(plan.body()).rejects.toBeInstanceOf(BackupIncompleteError);
	});

	it("plans a locked vault from the list it last read, for those exact bytes only", async () => {
		const a = await sealed(11);
		const { store } = memoryBlobStore();
		await store.put(a.hash, a.bytes);
		const vault = vaultWith(payload([a.record]));
		const cache = memoryCache();

		// Unlocked: read, and remembered.
		await planBackup({ vault, blobs: store, decryptWithVek: decrypt, listCache: cache });
		expect(cache.value).toEqual({ vaultHash: await sha256Hex(vault), hashes: [a.hash] });

		// Locked, same bytes: the remembered list stands in, and the backup is whole.
		const locked = await planBackup({
			vault,
			blobs: store,
			decryptWithVek: wrongKey,
			listCache: cache,
		});
		expect(locked.blocked).toBeUndefined();
		expect(locked.attachments).toBe(1);
		const opened = await openBackup(await locked.body());
		expect(opened.kind === "archive" && opened.attachments.length).toBe(1);

		// Locked, different bytes: the list no longer describes this vault.
		const changed = vaultWith(payload([a.record, (await sealed(12)).record]));
		const stale = await planBackup({
			vault: changed,
			blobs: store,
			decryptWithVek: wrongKey,
			listCache: cache,
		});
		expect(stale.blocked).toEqual({ reason: "locked" });
	});

	it("remembers an empty list too, so a locked vault without attachments still backs up", async () => {
		const vault = vaultWith(payload());
		const { store } = memoryBlobStore();
		const cache = memoryCache();
		await planBackup({ vault, blobs: store, decryptWithVek: decrypt, listCache: cache });
		const locked = await planBackup({
			vault,
			blobs: store,
			decryptWithVek: wrongKey,
			listCache: cache,
		});
		expect(locked.blocked).toBeUndefined();
		expect(await readWhole(await locked.body())).toEqual(vault);
	});
});

describe("planning reads no attachment until the file is needed", () => {
	it("decides from hashes alone", async () => {
		const a = await sealed(13);
		const { store } = memoryBlobStore();
		await store.put(a.hash, a.bytes);
		const read = vi.spyOn(store, "read");
		const plan = await planBackup({
			vault: vaultWith(payload([a.record])),
			blobs: store,
			decryptWithVek: decrypt,
		});
		expect(plan.fingerprint).toBe(
			await backupFingerprint(vaultWith(payload([a.record])), [a.hash]),
		);
		expect(read).not.toHaveBeenCalled();
		await plan.body();
		expect(read).toHaveBeenCalled();
	});
});

describe("backupFingerprint", () => {
	it("is the vault's plain hash with no attachments, and something else with them", async () => {
		const vault = vaultWith(payload());
		expect(await backupFingerprint(vault, [])).toBe(await sha256Hex(vault));
		expect(await backupFingerprint(vault, ["a".repeat(64)])).not.toBe(await sha256Hex(vault));
	});

	it("ignores order and repeats", async () => {
		const vault = vaultWith(payload());
		const [x, y] = ["a".repeat(64), "b".repeat(64)];
		expect(await backupFingerprint(vault, [x, y, x])).toBe(await backupFingerprint(vault, [y, x]));
	});
});

describe("openBackup is strict about what it accepts", () => {
	const vault = vaultWith(payload());
	const zipOf = (files: Record<string, Uint8Array>, level: 0 | 6 = 0) =>
		zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { level }]])));

	it("hands a plain vault back untouched, for the existing VLT1 checks", async () => {
		expect(await openBackup(bytesSource(vault))).toEqual({ kind: "vault", vault });
	});

	it("refuses an archive with anything a backup never contains", async () => {
		for (const name of ["../escape", "blobs/NOTHEX", "notes.txt", `blobs/${"a".repeat(63)}`]) {
			await expect(
				openBackup(bytesSource(zipOf({ [VAULT_ENTRY]: vault, [name]: fill(4, 1) }))),
			).rejects.toBeInstanceOf(BackupArchiveError);
		}
	});

	it("refuses an archive with no vault in it", async () => {
		await expect(
			openBackup(bytesSource(zipOf({ [`blobs/${"a".repeat(64)}`]: fill(4, 1) }))),
		).rejects.toThrow(/no vault/);
	});

	it("refuses a compressed entry", async () => {
		await expect(
			openBackup(bytesSource(zipOf({ [VAULT_ENTRY]: new Uint8Array(4096) }, 6))),
		).rejects.toBeInstanceOf(BackupArchiveError);
	});

	it("refuses an archive naming the same file twice", async () => {
		const entry = (bytes: Uint8Array) => {
			const crc = crc32();
			crc.update(bytes);
			return {
				name: VAULT_ENTRY,
				size: bytes.length,
				crc: crc.value,
				data: { kind: "bytes" as const, bytes },
			};
		};
		const layout = layoutZip([entry(vault), entry(fill(10, 9))]);
		const bytes = await readWhole({
			size: layout.size,
			read: async () =>
				Uint8Array.from(layout.parts.flatMap((p) => (p.kind === "bytes" ? [...p.bytes] : []))),
		});
		await expect(openBackup(bytesSource(bytes))).rejects.toBeInstanceOf(BackupArchiveError);
	});

	it("refuses a vault whose bytes do not match their CRC", async () => {
		const file = zipOf({ [VAULT_ENTRY]: vault });
		// Flip a byte inside the stored vault, leaving every header intact.
		const at = 30 + VAULT_ENTRY.length + 5;
		file[at] = (file[at] as number) ^ 0xff;
		await expect(openBackup(bytesSource(file))).rejects.toThrow(/damaged/);
	});

	it("refuses bytes that start like a ZIP but are not one", async () => {
		await expect(
			openBackup(bytesSource(Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0]))),
		).rejects.toThrow(/damaged/);
	});

	it("tells an unrelated ZIP from a backup", async () => {
		expect(await isBackupArchive(zipOf({ "readme.txt": te.encode("hi") }))).toBe(false);
		expect(await isBackupArchive(vault)).toBe(false);
	});
});

describe("ZIP64, for archives past 4 GB", () => {
	// Forced, so the large-archive fields are exercised without gigabytes of test data.
	it("reads back an archive written with every ZIP64 field", async () => {
		const vault = vaultWith(payload());
		const a = await sealed(14, 5000);
		const { store } = memoryBlobStore();
		await store.put(a.hash, a.bytes);
		const crcOf = (b: Uint8Array) => {
			const c = crc32();
			c.update(b);
			return c.value;
		};
		const layout = layoutZip(
			[
				{
					name: VAULT_ENTRY,
					size: vault.length,
					crc: crcOf(vault),
					data: { kind: "bytes", bytes: vault },
				},
				{
					name: `blobs/${a.hash}`,
					size: a.bytes.length,
					crc: crcOf(a.bytes),
					data: { kind: "blob", hash: a.hash, size: a.bytes.length },
				},
			],
			{ forceZip64: true },
		);
		const { layoutSource } = await import("./archive");
		const src = layoutSource(layout, store);
		const opened = await openBackup(src);
		expect(opened.vault).toEqual(vault);
		if (opened.kind !== "archive") throw new Error("expected an archive");
		const target = memoryBlobStore().store;
		await restoreAttachments(target, src, opened.attachments);
		expect(await target.read(a.hash)).toEqual(a.bytes);
	});
});

describe("restoreAttachments", () => {
	it("streams each attachment in bounded reads, never the whole file", async () => {
		const a = await sealed(15, 3 * 1024 * 1024);
		const { store } = memoryBlobStore();
		await store.put(a.hash, a.bytes);
		const built = await buildBackup({
			vault: vaultWith(payload([a.record])),
			blobs: store,
			decryptWithVek: decrypt,
		});
		const file = await readWhole(built.body);
		const lengths: number[] = [];
		const src: RandomAccessSource = {
			size: file.length,
			read: async (o, l) => {
				lengths.push(l);
				return file.subarray(o, o + l);
			},
		};
		const opened = await openBackup(src);
		if (opened.kind !== "archive") throw new Error("expected an archive");
		lengths.length = 0;
		const target = memoryBlobStore().store;
		expect(await restoreAttachments(target, src, opened.attachments)).toEqual({
			restored: 1,
			rejected: 0,
		});
		expect(Math.max(...lengths)).toBeLessThanOrEqual(1024 * 1024);
		expect(sameBytes(await target.read(a.hash), a.bytes)).toBe(true);
	});

	it("refuses a file whose bytes do not hash to its name, and keeps the others", async () => {
		const good = await sealed(16);
		const bad = await sealed(17);
		const file = zipSync({
			[VAULT_ENTRY]: [vaultWith(payload()), { level: 0 }],
			[`blobs/${good.hash}`]: [good.bytes, { level: 0 }],
			[`blobs/${bad.hash}`]: [fill(64, 99), { level: 0 }],
		});
		const opened = await openBackup(bytesSource(file));
		if (opened.kind !== "archive") throw new Error("expected an archive");
		const target = memoryBlobStore().store;
		expect(await restoreAttachments(target, bytesSource(file), opened.attachments)).toEqual({
			restored: 1,
			rejected: 1,
		});
		expect(await target.has(good.hash)).toBe(true);
		expect(await target.has(bad.hash)).toBe(false);
	});
});
