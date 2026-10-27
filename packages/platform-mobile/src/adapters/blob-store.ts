// Mobile BlobBackend: sealed attachment bytes on the app-private native filesystem, next to
// the vault blob. Deliberately NOT the App Group on iOS: autofill never needs attachments, so
// the credential provider's footprint stays small. See docs/file-attachments.md.
//
// Dumb byte I/O only. Staging, resume, verification and sweep all live in the shared
// createBlobStore, which is unit-tested on the host; nothing here decides anything.

import { Directory, Filesystem } from "@capacitor/filesystem";
import type { BlobBackend } from "@core/index";
import { base64ToBytes, bytesToBase64 } from "@core/util/bytes";
import { nativeFileCrypto } from "../native-crypto";
import { pathFromUri } from "./paths";

const DIR = Directory.Data;
/** Every vault's attachments live under here, one folder per vault, beside `vault-<id>.vlt1`. */
const BLOBS_ROOT = "blobs";
/** Staging is prefixed so `list()` can tell a half-written blob from a real one. */
const STAGING_PREFIX = ".staging-";
const HASH_RE = /^[0-9a-f]{64}$/;
/** A vault id becomes a folder name, so it must be one: no separators, no dots, nothing else.
 * Real ids are UUIDs from `crypto.randomUUID()`; this refuses anything that could climb out. */
const VAULT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** One vault's attachment folder. Throws on an id that is not a safe single path segment. */
export function blobDirFor(vaultId: string): string {
	if (!VAULT_ID_RE.test(vaultId)) throw new Error("vault id is not a safe folder name");
	return `${BLOBS_ROOT}/${vaultId}`;
}

/** Erase a vault's whole attachment folder. Idempotent: a vault that never had one is fine. */
export async function deleteMobileVaultBlobs(vaultId: string): Promise<void> {
	try {
		await Filesystem.rmdir({ path: blobDirFor(vaultId), directory: DIR, recursive: true });
	} catch {
		// Nothing there to delete.
	}
}

async function sizeOf(path: string): Promise<number | null> {
	try {
		return (await Filesystem.stat({ path, directory: DIR })).size;
	} catch {
		return null;
	}
}

/**
 * One vault's BlobBackend. Scoped to that vault's folder so nothing here can list, read or
 * delete another vault's files; see FileAdapter for why a shared store is not safe.
 */
export function createMobileBlobBackend(vaultId: string): BlobBackend {
	const dir = blobDirFor(vaultId);
	const blobPath = (hash: string) => `${dir}/${hash}`;
	const stagingPath = (key: string) => `${dir}/${STAGING_PREFIX}${key}`;

	/**
	 * A range of a file, read natively. Capacitor's Filesystem reads only whole files, which for
	 * a blob read in parts (a backup's layout, a peer's transfer) would read the whole blob per
	 * part. The native side seeks and reads just the range.
	 */
	const readRange = async (path: string, offset: number, length: number) => {
		const { uri } = await Filesystem.getUri({ path, directory: DIR });
		const { value } = await nativeFileCrypto.readFileRange({
			path: pathFromUri(uri),
			offset,
			length,
		});
		const bytes = base64ToBytes(value);
		if (bytes.length !== length) throw new Error("an attachment is shorter than recorded");
		return bytes;
	};
	const ensureDir = async (): Promise<void> => {
		try {
			await Filesystem.mkdir({ path: dir, directory: DIR, recursive: true });
		} catch {
			// Already there. mkdir has no "if not exists", and stat-then-mkdir races with itself.
		}
	};

	return {
		async appendStaged(hash, bytes) {
			await ensureDir();
			// appendFile creates the file when absent, which is what makes the store's
			// "materialize staging on receive" call work for a zero-length blob.
			await Filesystem.appendFile({
				path: stagingPath(hash),
				directory: DIR,
				data: bytesToBase64(bytes),
			});
		},

		async stagedSize(hash) {
			return (await sizeOf(stagingPath(hash))) ?? 0;
		},

		readStaged: (hash, offset, length) => readRange(stagingPath(hash), offset, length),

		async publishStaged(hash) {
			await ensureDir();
			await Filesystem.rename({
				from: stagingPath(hash),
				to: blobPath(hash),
				directory: DIR,
				toDirectory: DIR,
			});
		},

		async discardStaged(hash) {
			try {
				await Filesystem.deleteFile({ path: stagingPath(hash), directory: DIR });
			} catch {
				// Nothing staged. Discard is idempotent by contract.
			}
		},

		async has(hash) {
			return (await sizeOf(blobPath(hash))) !== null;
		},

		size: (hash) => sizeOf(blobPath(hash)),

		read: (hash, offset, length) => readRange(blobPath(hash), offset, length),

		async remove(hash) {
			try {
				await Filesystem.deleteFile({ path: blobPath(hash), directory: DIR });
			} catch {
				// Already gone.
			}
		},

		async list() {
			await ensureDir();
			const { files } = await Filesystem.readdir({ path: dir, directory: DIR });
			// Filter by the hash shape rather than by "not staging": anything else in here is
			// not a blob, and a sweep must never delete a file it does not understand.
			return files
				.filter((f) => f.type === "file" && HASH_RE.test(f.name))
				.map((f) => ({ hash: f.name, size: f.size }));
		},

		// --- native seal path (see BlobBackend.reserveStagingPath) ---

		async reserveStagingPath(token) {
			await ensureDir();
			// Rust opens this with std::fs, so it needs a plain path, not Capacitor's file:// URI.
			const { uri } = await Filesystem.getUri({ path: stagingPath(token), directory: DIR });
			return pathFromUri(uri);
		},

		async adoptStagingPath(token, hash) {
			await Filesystem.rename({
				from: stagingPath(token),
				to: blobPath(hash),
				directory: DIR,
				toDirectory: DIR,
			});
		},
	};
}
