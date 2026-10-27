// An in-memory BlobBackend and a real hasher, for tests of anything built on BlobStore.
import { type BlobBackend, type BlobHasher, createBlobStore } from "../vault/blob-store";

export function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Real SHA-256, buffered. Small in tests, and using the genuine digest is the point: the
 * mismatch and resume cases only mean something if the hash is really computed. */
export function realHasher(): BlobHasher {
	const parts: Uint8Array[] = [];
	return {
		update(bytes) {
			parts.push(new Uint8Array(bytes));
		},
		async finish() {
			return sha256Hex(concat(parts));
		},
	};
}

/** The dumbest backend that satisfies the contract, so a test exercises the shared logic. */
export function memoryBackend() {
	const blobs = new Map<string, Uint8Array>();
	const staged = new Map<string, Uint8Array>();
	const backend: BlobBackend = {
		appendStaged: async (hash, bytes) => {
			staged.set(hash, concat([staged.get(hash) ?? new Uint8Array(0), bytes]));
		},
		stagedSize: async (hash) => staged.get(hash)?.length ?? 0,
		readStaged: async (hash, offset, length) =>
			(staged.get(hash) ?? new Uint8Array(0)).slice(offset, offset + length),
		publishStaged: async (hash) => {
			const bytes = staged.get(hash);
			if (!bytes) throw new Error("nothing staged");
			blobs.set(hash, bytes);
			staged.delete(hash);
		},
		discardStaged: async (hash) => void staged.delete(hash),
		has: async (hash) => blobs.has(hash),
		size: async (hash) => blobs.get(hash)?.length ?? null,
		read: async (hash, offset, length) =>
			(blobs.get(hash) ?? new Uint8Array(0)).slice(offset, offset + length),
		remove: async (hash) => void blobs.delete(hash),
		list: async () => [...blobs].map(([hash, bytes]) => ({ hash, size: bytes.length })),
	};
	return { backend, blobs, staged };
}

/** A BlobStore over a fresh memory backend, which is returned too, for planting bytes beneath
 * the store's own checks. */
export function memoryBlobStore() {
	const { backend, blobs, staged } = memoryBackend();
	return { store: createBlobStore({ backend, createHasher: realHasher }), backend, blobs, staged };
}

/** Byte equality without a deep-equal walk, which is slow enough on megabytes to time a test out. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
