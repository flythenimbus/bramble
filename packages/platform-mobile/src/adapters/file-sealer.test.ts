import type { BlobStore, FileRecord } from "@core/index";
import { describe, expect, it } from "vitest";
import { createMobileFileSealer } from "./file-sealer";

/** Records what the sealer asks of the store; the real one is exercised on device. */
function fakeBlobs() {
	const calls: string[] = [];
	const blobs: Pick<BlobStore, "reserveStagingPath" | "adoptStagingPath" | "discardStagingPath"> = {
		reserveStagingPath: async (token) => {
			calls.push(`reserve:${token}`);
			return `/data/blobs/.staging-${token}`;
		},
		adoptStagingPath: async (token, hash) => {
			calls.push(`adopt:${token}->${hash}`);
		},
		discardStagingPath: async (token) => {
			calls.push(`discard:${token}`);
		},
	};
	return { blobs: blobs as BlobStore, calls };
}

const HASH = "a".repeat(64);

const sealed = {
	hash: HASH,
	size: 1040,
	noncePrefix: "cHJlZml4MA==",
	wrappedFek: "wf",
	fekIv: "fi",
	metaBlob: "mb",
	metaIv: "mi",
};

const record = (): FileRecord => ({
	id: "f1",
	hlc: { wall: 1, counter: 0, node: "n" },
	...sealed,
});

describe("createMobileFileSealer", () => {
	it("seals into a reserved path, then adopts it under the hash that came back", async () => {
		const { blobs, calls } = fakeBlobs();
		let sawDst = "";
		let sawMeta = "";
		const sealer = createMobileFileSealer({
			blobs,
			native: {
				sealFile: async ({ dstPath, metaJson }) => {
					sawDst = dstPath;
					sawMeta = metaJson;
					return sealed;
				},
				resealFileMeta: async () => ({ iv: "i", ciphertext: "c" }),
				openFileMeta: async () => ({ value: "{}" }),
			},
		});

		const out = await sealer.seal(
			{ kind: "path", path: "/sdcard/passport.pdf" },
			{ name: "passport.pdf", mime: "application/pdf" },
		);

		expect(out).toEqual(sealed);
		// Sealed into the reservation, adopted under the hash: the address cannot be known
		// before the last chunk is written, so the order here is the whole mechanism.
		const token = calls[0]?.slice("reserve:".length) as string;
		expect(sawDst).toBe(`/data/blobs/.staging-${token}`);
		expect(calls).toEqual([`reserve:${token}`, `adopt:${token}->${HASH}`]);
		// Only what cannot be derived from the record gets sealed.
		expect(JSON.parse(sawMeta)).toEqual({ name: "passport.pdf", mime: "application/pdf" });
	});

	// A failed seal must DISCARD. Adopting would publish a half-written file under some
	// address, breaking the one thing a blob store promises: what it holds hashes to its name.
	it("discards the reservation when sealing fails, and never adopts", async () => {
		const { blobs, calls } = fakeBlobs();
		const sealer = createMobileFileSealer({
			blobs,
			native: {
				sealFile: async () => {
					throw new Error("disk full");
				},
				resealFileMeta: async () => ({ iv: "i", ciphertext: "c" }),
				openFileMeta: async () => ({ value: "{}" }),
			},
		});

		await expect(
			sealer.seal({ kind: "path", path: "/x" }, { name: "a.pdf", mime: "application/pdf" }),
		).rejects.toThrow("disk full");

		expect(calls.some((c) => c.startsWith("adopt:"))).toBe(false);
		expect(calls.filter((c) => c.startsWith("discard:"))).toHaveLength(1);
	});

	it("refuses a source it cannot seal from, before reserving anything", async () => {
		const { blobs, calls } = fakeBlobs();
		const sealer = createMobileFileSealer({
			blobs,
			native: {
				sealFile: async () => sealed,
				resealFileMeta: async () => ({ iv: "i", ciphertext: "c" }),
				openFileMeta: async () => ({ value: "{}" }),
			},
		});
		await expect(
			sealer.seal({ kind: "bytes", bytes: new Uint8Array(1) }, { name: "a", mime: "b" }),
		).rejects.toThrow(/seals from a path or a blob/);
		expect(calls).toEqual([]);
	});

	it("reseals metadata for a rename without touching the blob", async () => {
		const { blobs, calls } = fakeBlobs();
		let sawMeta = "";
		const sealer = createMobileFileSealer({
			blobs,
			native: {
				sealFile: async () => sealed,
				resealFileMeta: async ({ metaJson }) => {
					sawMeta = metaJson;
					return { iv: "newIv", ciphertext: "newBlob" };
				},
				openFileMeta: async () => ({ value: "{}" }),
			},
		});

		const out = await sealer.resealMeta(record(), { name: "new.pdf", mime: "application/pdf" });
		expect(out).toEqual({ metaBlob: "newBlob", metaIv: "newIv" });
		expect(JSON.parse(sawMeta).name).toBe("new.pdf");
		// No staging, no adopt: a rename moves no bytes.
		expect(calls).toEqual([]);
	});

	it("describes a record, and rejects malformed metadata", async () => {
		const { blobs } = fakeBlobs();
		const make = (value: string) =>
			createMobileFileSealer({
				blobs,
				native: {
					sealFile: async () => sealed,
					resealFileMeta: async () => ({ iv: "i", ciphertext: "c" }),
					openFileMeta: async () => ({ value }),
				},
			});

		expect(await make('{"name":"a.pdf","mime":"application/pdf"}').describe(record())).toEqual({
			name: "a.pdf",
			mime: "application/pdf",
		});
		// Metadata is decrypted input; a shape check is cheap and the alternative is undefined
		// flowing into the UI as a filename.
		await expect(make('{"name":"a.pdf"}').describe(record())).rejects.toThrow(/malformed/);
		await expect(make("not json").describe(record())).rejects.toThrow();
	});
});
