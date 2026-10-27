// Where an attachment's sealed bytes live. Deliberately NOT the vault blob: that is rewritten
// on every entry edit and rebroadcast to every peer every few seconds, which is exactly what a
// 100 MB file must not do. See docs/file-attachments.md.
//
// One implementation, three platforms. Everything interesting (staging, resume, verify before
// publish, range clamping, sweep) lives here and is unit-tested against a memory backend; each
// platform supplies only BlobBackend, which is dumb byte I/O with no rules of its own. That
// split is deliberate: the native backends can only be exercised on a device, so none of the
// logic that can get a file quietly corrupted should live in them.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { BLOB_HASH_RE } from "../sync/entries-payload";

/** A value a platform may return synchronously or not: the native hashers go over a bridge. */
type Awaitable<T> = T | Promise<T>;

/**
 * Incremental SHA-256 over a blob's sealed bytes, supplied by the platform (core-rust's
 * BlobHasher via wasm or uniffi). Incremental rather than one-shot because the alternative is
 * holding a whole attachment in memory, and because WebCrypto has no streaming digest.
 */
export interface BlobHasher {
	update(bytes: Uint8Array): Awaitable<void>;
	/** Lowercase hex. Consumes the hasher. */
	finish(): Awaitable<string>;
}

/** Raw byte I/O for one platform. No validation, no verification, no policy. */
export interface BlobBackend {
	/** Append to a staged object, creating it on the first call. */
	appendStaged(hash: string, bytes: Uint8Array): Promise<void>;
	/** Bytes currently staged, 0 when there is no staging for this hash. */
	stagedSize(hash: string): Promise<number>;
	/** Read a range of a staged object, for rehashing a resumed prefix. */
	readStaged(hash: string, offset: number, length: number): Promise<Uint8Array>;
	/** Promote a staged object to a committed blob. Atomic where the platform allows. */
	publishStaged(hash: string): Promise<void>;
	discardStaged(hash: string): Promise<void>;

	has(hash: string): Promise<boolean>;
	/** Committed length, or null when absent. */
	size(hash: string): Promise<number | null>;
	/** Read a committed range. The caller has already clamped it to the blob. */
	read(hash: string, offset: number, length: number): Promise<Uint8Array>;
	remove(hash: string): Promise<void>;
	list(): Promise<{ hash: string; size: number }[]>;

	/**
	 * Native only: lend the platform's own sealer somewhere to write, then adopt the result.
	 *
	 * A blob is addressed by the hash of its ciphertext, which a streaming sealer only learns
	 * as it finishes, so it cannot be told its final name up front. These two bracket that:
	 * reserve a scratch path, seal into it, adopt it under the hash that came back. No
	 * verification happens on adopt, because the hash came from the same pass that wrote the
	 * bytes; re-reading the file to confirm would be checking the sealer against itself.
	 *
	 * Absent where there is no filesystem to hand out (the extension's IndexedDB store), whose
	 * sealer produces bytes in memory and goes through `put`. Callers must feature-detect.
	 */
	reserveStagingPath?(token: string): Promise<string>;
	adoptStagingPath?(token: string, hash: string): Promise<void>;
}

/**
 * An in-progress receive. Bytes are staged, never visible as a blob, until the accumulated
 * content hashes to the address it was requested under.
 */
export interface BlobReceipt {
	/** Bytes already staged when this receipt opened: what a peer should resume from. */
	readonly resumeFrom: number;
	/** Append the next contiguous bytes. Returns the new staged total. */
	append(bytes: Uint8Array): Promise<number>;
	/** Verify and publish. Throws (and discards the staging) on a hash mismatch. */
	commit(): Promise<void>;
	abort(): Promise<void>;
}

export interface BlobStore {
	has(hash: string): Promise<boolean>;
	size(hash: string): Promise<number | null>;
	/** Read a committed blob, or a range of it. Clamped to the blob's extent. */
	read(hash: string, offset?: number, length?: number): Promise<Uint8Array>;
	/** Begin or resume receiving the blob with this address. Throws if it is already held. */
	receive(hash: string): Promise<BlobReceipt>;
	/** Store a blob already fully in memory. For a locally sealed file, which is produced whole. */
	put(hash: string, bytes: Uint8Array): Promise<void>;
	delete(hash: string): Promise<void>;
	list(): Promise<string[]>;
	totalBytes(): Promise<number>;
	/** See `BlobBackend.reserveStagingPath`. Null where the platform has no filesystem. */
	reserveStagingPath(token: string): Promise<string | null>;
	/** See `BlobBackend.adoptStagingPath`. Throws where the platform has no filesystem. */
	adoptStagingPath(token: string, hash: string): Promise<void>;
	/** Drop a reservation without publishing it, for a seal that failed partway. */
	discardStagingPath(token: string): Promise<void>;
	/**
	 * Delete every blob whose hash is not in `keep`, returning what was removed.
	 *
	 * The mechanism only. The GC *policy* (a grace period before an unreferenced blob is
	 * collected, so a device that has been offline cannot have its still-referenced bytes swept
	 * out from under it) belongs to the caller that computes `keep`.
	 */
	sweep(keep: Iterable<string>): Promise<string[]>;
}

export interface BlobStoreDeps {
	backend: BlobBackend;
	/** A fresh hasher per receive. */
	createHasher: () => BlobHasher;
}

/** Window used to re-read a staged prefix when resuming. Bounded so resume is not a big alloc. */
const REHASH_WINDOW = 256 * 1024;

function assertHash(hash: string): void {
	if (!BLOB_HASH_RE.test(hash)) throw new Error(`not a blob hash: ${hash}`);
}

export function createBlobStore({ backend, createHasher }: BlobStoreDeps): BlobStore {
	const store: BlobStore = {
		async has(hash) {
			assertHash(hash);
			return backend.has(hash);
		},

		async size(hash) {
			assertHash(hash);
			return backend.size(hash);
		},

		async read(hash, offset = 0, length) {
			assertHash(hash);
			if (offset < 0 || (length !== undefined && length < 0)) {
				throw new Error("blob read range must not be negative");
			}
			const total = await backend.size(hash);
			if (total === null) throw new Error(`blob not held: ${hash}`);
			// Clamped rather than rejected: a peer asking for the tail of a blob should not have to
			// know its exact length to ask, and a short read is the honest answer for past the end.
			const start = Math.min(offset, total);
			const want = length === undefined ? total - start : Math.min(length, total - start);
			if (want === 0) return new Uint8Array(0);
			return backend.read(hash, start, want);
		},

		async receive(hash) {
			assertHash(hash);
			if (await backend.has(hash)) throw new Error(`blob already held: ${hash}`);

			const hasher = createHasher();
			// Resume: the staged prefix survives a restart but the hasher does not, so replay the
			// prefix through a fresh hasher. One local pass, only on resume, and the alternative is
			// refetching a large attachment from zero every time a transfer is interrupted.
			let staged = await backend.stagedSize(hash);
			for (let at = 0; at < staged; at += REHASH_WINDOW) {
				const window = Math.min(REHASH_WINDOW, staged - at);
				await hasher.update(await backend.readStaged(hash, at, window));
			}
			// Materialize the staging up front rather than leaving it to the first append. A
			// sealed blob is never actually empty (it carries at least one AEAD tag), but without
			// this a zero-byte receive commits with nothing staged, and every platform backend
			// would have to independently decide what publishing nothing means.
			if (staged === 0) await backend.appendStaged(hash, new Uint8Array(0));

			let open = true;
			const resumeFrom = staged;
			return {
				resumeFrom,
				async append(bytes) {
					if (!open) throw new Error("blob receipt is closed");
					if (bytes.length === 0) return staged;
					await backend.appendStaged(hash, bytes);
					await hasher.update(bytes);
					staged += bytes.length;
					return staged;
				},
				async commit() {
					if (!open) throw new Error("blob receipt is closed");
					open = false;
					const actual = await hasher.finish();
					if (actual !== hash) {
						// Discard rather than keep: a retry would otherwise append to a poisoned
						// prefix and could never converge on the right hash.
						await backend.discardStaged(hash);
						throw new Error(`blob hash mismatch: wanted ${hash}, got ${actual}`);
					}
					await backend.publishStaged(hash);
				},
				async abort() {
					if (!open) return;
					open = false;
					await backend.discardStaged(hash);
				},
			};
		},

		async put(hash, bytes) {
			assertHash(hash);
			if (await backend.has(hash)) return; // content-addressed: already correct by definition
			// Through the same staging and verification path as a transfer, so a locally sealed
			// blob cannot be published under an address it does not hash to.
			await backend.discardStaged(hash);
			const receipt = await store.receive(hash);
			await receipt.append(bytes);
			await receipt.commit();
		},

		async reserveStagingPath(token) {
			return backend.reserveStagingPath ? backend.reserveStagingPath(token) : null;
		},

		async adoptStagingPath(token, hash) {
			assertHash(hash);
			if (!backend.adoptStagingPath) throw new Error("this blob store has no staging paths");
			await backend.adoptStagingPath(token, hash);
		},

		async discardStagingPath(token) {
			// Reuses the transfer staging namespace: both are keyed by an opaque string, and a
			// reservation that is never adopted is exactly an abandoned staging object.
			await backend.discardStaged(token);
		},

		async delete(hash) {
			assertHash(hash);
			await backend.remove(hash);
			await backend.discardStaged(hash);
		},

		async list() {
			return (await backend.list()).map((b) => b.hash);
		},

		async totalBytes() {
			return (await backend.list()).reduce((sum, b) => sum + b.size, 0);
		},

		async sweep(keep) {
			const keepSet = new Set(keep);
			const removed: string[] = [];
			for (const { hash } of await backend.list()) {
				if (keepSet.has(hash)) continue;
				await backend.remove(hash);
				removed.push(hash);
			}
			return removed;
		},
	};
	return store;
}

/**
 * Incremental SHA-256, for checking a blob as it arrives without holding it: WebCrypto has no
 * streaming digest, and an attachment of any size must be verifiable in bounded memory. The
 * native sealers hash as they write and never come through here; this is for `receive`, which is
 * restoring a backup and, with blob sync, every file a peer sends. Shared by every platform.
 */
export function createBlobHasher(): BlobHasher {
	const hash = sha256.create();
	return {
		update(bytes) {
			hash.update(bytes);
		},
		finish() {
			return bytesToHex(hash.digest());
		},
	};
}
