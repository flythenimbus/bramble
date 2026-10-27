// Mobile FileSealer: turns a picked file into a sealed blob. See docs/file-attachments.md.
//
// The seal itself never puts plaintext on the bridge: the webview hands native two paths and
// a few hundred bytes of metadata JSON, and Rust reads, seals, hashes and writes on its side.
//
// There IS one copy, and it is worth being honest about. A file picked with `<input type=file>`
// arrives as a Blob, because no plugin here can pick a file BY PATH: the webview holds the
// bytes and native does not. So a Blob is spooled to a temp path first, in bounded slices. A
// native picker returning a content URI would remove that copy entirely and is the follow-up;
// until then the cost is one pass over the file, not one per chunk.

import { Directory, Filesystem } from "@capacitor/filesystem";
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
import { bytesToBase64 } from "@core/util/bytes";
import { type NativeFileCrypto, nativeFileCrypto } from "../native-crypto";
import { pathFromUri } from "./paths";

/** Slice size when spooling a picked Blob to disk: steady memory, not one huge base64 string. */
const SPOOL_SLICE = 256 * 1024;
/** Spooled originals sit beside the blobs, and are deleted as soon as the seal returns. */
const SPOOL_DIR = "blobs";

export interface MobileFileSealerDeps {
	blobs: BlobStore;
	/** Injected so tests can drive the seam without a device. */
	native?: Pick<NativeFileCrypto, "sealFile" | "resealFileMeta" | "openFileMeta">;
}

/**
 * Write a Blob to a temp file slice by slice. Returns the absolute path (what Rust opens) and
 * the relative one (what Capacitor deletes by).
 */
async function spoolToPath(blob: Blob): Promise<{ path: string; rel: string }> {
	const rel = `${SPOOL_DIR}/.spool-${globalThis.crypto.randomUUID()}`;
	await Filesystem.mkdir({ path: SPOOL_DIR, directory: Directory.Data, recursive: true }).catch(
		() => {},
	);
	// Create (or truncate) first, so a leftover file can never be appended to.
	await Filesystem.writeFile({ path: rel, directory: Directory.Data, data: "" });
	for (let at = 0; at < blob.size; at += SPOOL_SLICE) {
		const slice = new Uint8Array(await blob.slice(at, at + SPOOL_SLICE).arrayBuffer());
		await Filesystem.appendFile({
			path: rel,
			directory: Directory.Data,
			data: bytesToBase64(slice),
		});
	}
	const { uri } = await Filesystem.getUri({ path: rel, directory: Directory.Data });
	return { path: pathFromUri(uri), rel };
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
				const spooled = await spoolToPath(source.blob);
				try {
					return await sealFromPath(spooled.path, meta);
				} finally {
					// The spooled original is PLAINTEXT on disk, so it goes as soon as the seal
					// returns, whether or not it succeeded. Hence `finally`, not the happy path.
					await Filesystem.deleteFile({ path: spooled.rel, directory: Directory.Data }).catch(
						() => {},
					);
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
