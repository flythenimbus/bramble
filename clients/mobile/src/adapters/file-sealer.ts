// Mobile FileSealer: turns a picked file into a sealed blob. See docs/file-attachments.md.
//
// The seal itself never puts plaintext on the bridge: the webview hands native two paths and
// a few hundred bytes of metadata JSON, and Rust reads, seals, hashes and writes on its side.
//
// There IS one copy, and it is worth being honest about. A file picked with `<input type=file>`
// arrives as a Blob, because no plugin here can pick a file BY PATH: the webview holds the
// bytes and native does not. So a Blob is spooled to a temp file first, in bounded slices. A
// native picker returning a content URI would remove that copy entirely and is the follow-up;
// until then the cost is one pass over the file, not one per chunk.
//
// That copy is plaintext, so it lives in the cache dir, which no device backup includes, and is
// deleted as soon as the seal returns, and at startup if a crash left it behind.

import { Directory, Filesystem } from "@capacitor/filesystem";
import { fileSource } from "@core/backup/restore";
import {
	type BlobStore,
	decodeFileMeta,
	encodeFileMeta,
	type FileMeta,
	type FileRecord,
	type FileSealer,
	type FileSource,
	type SealedFile,
} from "@core/index";
import { type NativeFileCrypto, nativeFileCrypto } from "../native-crypto";
import { dropSpooled, spoolToCache } from "./spool";

/** Spooled originals, one file per seal, in the cache dir. */
const SPOOL_DIR = "seal";
/** Where builds before the cache spool left theirs: beside the blobs, in the backed-up data dir. */
const LEGACY_SPOOL_DIR = "blobs";
const LEGACY_SPOOL_PREFIX = ".spool-";

export interface MobileFileSealerDeps {
	blobs: BlobStore;
	/** Injected so tests can drive the seam without a device. */
	native?: Pick<NativeFileCrypto, "sealFile" | "resealFileMeta" | "openFileMeta">;
}

/**
 * Delete every spooled original, including those older builds left in the data dir. Run at
 * startup, when no seal can be in flight; never on lock, since deleting a spool still being
 * written would seal a truncated file.
 */
export async function sweepSealSpools(): Promise<void> {
	await Filesystem.rmdir({ path: SPOOL_DIR, directory: Directory.Cache, recursive: true }).catch(
		() => {},
	);
	const legacy = await Filesystem.readdir({
		path: LEGACY_SPOOL_DIR,
		directory: Directory.Data,
	}).catch(() => null);
	for (const { name } of legacy?.files ?? []) {
		if (!name.startsWith(LEGACY_SPOOL_PREFIX)) continue;
		await Filesystem.deleteFile({
			path: `${LEGACY_SPOOL_DIR}/${name}`,
			directory: Directory.Data,
		}).catch(() => {});
	}
}

export function createMobileFileSealer({
	blobs,
	native = nativeFileCrypto,
}: MobileFileSealerDeps): FileSealer {
	async function sealFromPath(srcPath: string, meta: FileMeta): Promise<SealedFile> {
		// The blob's address is the hash of its own ciphertext, which is not known until the
		// last chunk is written, so seal into a reserved scratch path and adopt it after.
		const token = globalThis.crypto.randomUUID();
		const dstPath = await blobs.reserveStagingPath(token);
		if (!dstPath) throw new Error("this platform has no staging path for sealing");

		let sealed: SealedFile;
		try {
			sealed = await native.sealFile({ srcPath, dstPath, metaJson: encodeFileMeta(meta) });
		} catch (e) {
			// Discard, never adopt: adopting here would publish a half-written file under some
			// address, and a blob store's whole contract is that what it holds hashes to its
			// name. The manifest was never written, so there is nothing else to undo.
			await blobs.discardStagingPath(token).catch(() => {});
			throw e;
		}
		await blobs.adoptStagingPath(token, sealed.hash);
		return sealed;
	}

	return {
		async seal(source: FileSource, meta): Promise<SealedFile> {
			if (source.kind === "blob") {
				const name = `${SPOOL_DIR}/${globalThis.crypto.randomUUID()}`;
				try {
					const { path } = await spoolToCache(name, fileSource(source.blob));
					return await sealFromPath(path, meta);
				} finally {
					// The spooled original is PLAINTEXT on disk, so it goes as soon as the seal
					// returns or spooling fails. Hence `finally`, not the happy path.
					await dropSpooled(name);
				}
			}
			if (source.kind !== "path") {
				throw new Error(`mobile seals from a path or a blob, got ${source.kind}`);
			}
			return sealFromPath(source.path, meta);
		},

		async resealMeta(record: FileRecord, meta) {
			const out = await native.resealFileMeta({
				wrappedFekB64: record.wrappedFek,
				fekIvB64: record.fekIv,
				metaJson: encodeFileMeta(meta),
			});
			return { metaBlob: out.ciphertext, metaIv: out.iv };
		},

		async describe(record: FileRecord): Promise<FileMeta> {
			const { value } = await native.openFileMeta({
				wrappedFekB64: record.wrappedFek,
				fekIvB64: record.fekIv,
				metaBlobB64: record.metaBlob,
				metaIvB64: record.metaIv,
			});
			return decodeFileMeta(value);
		},
	};
}
