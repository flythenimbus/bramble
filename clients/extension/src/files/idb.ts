// The extension's attachment store: IndexedDB, shared by every extension context (popup,
// options, the offscreen host, the background), so bytes move between them by key rather than
// through chrome.runtime messaging. See docs/file-attachments.md.
//
// Not chrome.storage.local: that is a serializing key-value store, so a 50 MB value would be a
// base64 round trip on every touch. IndexedDB holds binary natively and reads one part without
// the rest.
//
// Two layers. `objects` names things: [vaultId, "blob" | "staged", name] -> { obj, size }.
// `parts` holds the bytes: [obj, index] -> one PART_LEN slice. The indirection is what makes
// publishing a staged blob one small atomic write instead of a copy of every part.

import {
	type BlobBackend,
	type BlobStore,
	createBlobHasher,
	createBlobStore,
} from "@core/vault/blob-store";

const DB_NAME = "bramble-files";
const DB_VERSION = 1;
const OBJECTS = "objects";
const PARTS = "parts";
// Plaintext passed between contexts: a picked file on its way to be sealed, or an opened one on
// its way to a download. Short-lived by design, and cleared on lock.
const HANDOFF = "handoff";

/** One sealed chunk per part, so chunk i of a blob is part i and a range read is a key range. */
export const PART_LEN = 256 * 1024 + 16;

type Kind = "blob" | "staged";
interface ObjectRecord {
	obj: string;
	size: number;
}
interface HandoffRecord {
	blob: Blob;
	at: number;
}

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
	if (!opening) {
		opening = new Promise<IDBDatabase>((resolve, reject) => {
			const r = indexedDB.open(DB_NAME, DB_VERSION);
			r.onupgradeneeded = () => {
				const db = r.result;
				if (!db.objectStoreNames.contains(OBJECTS)) db.createObjectStore(OBJECTS);
				if (!db.objectStoreNames.contains(PARTS)) db.createObjectStore(PARTS);
				if (!db.objectStoreNames.contains(HANDOFF)) db.createObjectStore(HANDOFF);
			};
			r.onsuccess = () => {
				const db = r.result;
				// Another context upgrading must not be blocked by this one holding it open.
				db.onversionchange = () => {
					db.close();
					opening = null;
				};
				resolve(db);
			};
			r.onerror = () => reject(r.error);
			r.onblocked = () => reject(new Error("attachment store is blocked by another context"));
		}).catch((e) => {
			opening = null;
			throw e;
		});
	}
	return opening;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
}

/**
 * Run `body` in one transaction and resolve once it has committed.
 *
 * `body` may await only requests on `tx`: anything else (a fetch, WebCrypto) lets the
 * transaction auto-commit underneath it.
 */
async function transact<T>(
	stores: string[],
	mode: IDBTransactionMode,
	body: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
	const db = await openDb();
	const tx = db.transaction(stores, mode);
	const committed = new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error("attachment store transaction aborted"));
	});
	let result: T;
	try {
		result = await body(tx);
	} catch (e) {
		try {
			tx.abort();
		} catch {}
		committed.catch(() => {});
		throw e;
	}
	await committed;
	return result;
}

const objectKey = (vaultId: string, kind: Kind, name: string) => [vaultId, kind, name];
const partsOf = (obj: string) => IDBKeyRange.bound([obj, 0], [obj, Number.POSITIVE_INFINITY]);

async function getObject(
	tx: IDBTransaction,
	vaultId: string,
	kind: Kind,
	name: string,
): Promise<ObjectRecord | undefined> {
	return req(tx.objectStore(OBJECTS).get(objectKey(vaultId, kind, name))) as Promise<
		ObjectRecord | undefined
	>;
}

async function dropObject(
	tx: IDBTransaction,
	vaultId: string,
	kind: Kind,
	name: string,
): Promise<void> {
	const rec = await getObject(tx, vaultId, kind, name);
	if (!rec) return;
	await req(tx.objectStore(OBJECTS).delete(objectKey(vaultId, kind, name)));
	await req(tx.objectStore(PARTS).delete(partsOf(rec.obj)));
}

async function readRange(
	vaultId: string,
	kind: Kind,
	name: string,
	offset: number,
	length: number,
): Promise<Uint8Array> {
	return transact([OBJECTS, PARTS], "readonly", async (tx) => {
		const rec = await getObject(tx, vaultId, kind, name);
		if (!rec) throw new Error(`no ${kind} object ${name}`);
		if (offset < 0 || length < 0 || offset + length > rec.size) {
			throw new Error("read past the end of an attachment object");
		}
		const out = new Uint8Array(length);
		if (length === 0) return out;
		const first = Math.floor(offset / PART_LEN);
		const last = Math.floor((offset + length - 1) / PART_LEN);
		const parts = (await req(
			tx.objectStore(PARTS).getAll(IDBKeyRange.bound([rec.obj, first], [rec.obj, last])),
		)) as Uint8Array[];
		if (parts.length !== last - first + 1) throw new Error("attachment object is missing parts");
		let written = 0;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i] as Uint8Array;
			const start = i === 0 ? offset - first * PART_LEN : 0;
			const take = Math.min(part.length - start, length - written);
			out.set(part.subarray(start, start + take), written);
			written += take;
		}
		if (written !== length) throw new Error("attachment object is shorter than recorded");
		return out;
	});
}

async function appendStaged(vaultId: string, key: string, bytes: Uint8Array): Promise<void> {
	await transact([OBJECTS, PARTS], "readwrite", async (tx) => {
		const parts = tx.objectStore(PARTS);
		const rec = (await getObject(tx, vaultId, "staged", key)) ?? {
			obj: globalThis.crypto.randomUUID(),
			size: 0,
		};
		let size = rec.size;
		let at = 0;
		let index = Math.floor(size / PART_LEN);
		// Top up a partial last part first, so every part but the last stays exactly PART_LEN.
		const tail = size % PART_LEN;
		if (tail > 0 && bytes.length > 0) {
			const prev = (await req(parts.get([rec.obj, index]))) as Uint8Array | undefined;
			if (!prev || prev.length !== tail) throw new Error("staged attachment is inconsistent");
			const fill = Math.min(PART_LEN - tail, bytes.length);
			const merged = new Uint8Array(tail + fill);
			merged.set(prev);
			merged.set(bytes.subarray(0, fill), tail);
			await req(parts.put(merged, [rec.obj, index]));
			at = fill;
			size += fill;
			if (size % PART_LEN === 0) index++;
		}
		while (at < bytes.length) {
			const n = Math.min(PART_LEN, bytes.length - at);
			// A copy, not a view: cloning a view stores its whole underlying buffer.
			await req(parts.put(bytes.slice(at, at + n), [rec.obj, index]));
			index++;
			at += n;
			size += n;
		}
		await req(
			tx.objectStore(OBJECTS).put({ obj: rec.obj, size }, objectKey(vaultId, "staged", key)),
		);
	});
}

/**
 * Publish staged bytes under a blob name, in one transaction. No verification: `BlobStore`
 * verifies before it calls this, and the host's sealer names its output by the hash it computed
 * while writing it.
 */
export async function publishStagedAs(vaultId: string, key: string, hash: string): Promise<void> {
	await transact([OBJECTS, PARTS], "readwrite", async (tx) => {
		const staged = await getObject(tx, vaultId, "staged", key);
		if (!staged) throw new Error("nothing staged to publish");
		await req(tx.objectStore(OBJECTS).delete(objectKey(vaultId, "staged", key)));
		if (await getObject(tx, vaultId, "blob", hash)) {
			// Content-addressed: the blob already held is the same bytes.
			await req(tx.objectStore(PARTS).delete(partsOf(staged.obj)));
			return;
		}
		await req(tx.objectStore(OBJECTS).put(staged, objectKey(vaultId, "blob", hash)));
	});
}

/** A vault's attachment store, as every extension context opens it: the view, the crypto host
 * and the backup runner all read and write the same IndexedDB. */
export function idbBlobStore(vaultId: string): BlobStore {
	return createBlobStore({ backend: idbBlobBackend(vaultId), createHasher: createBlobHasher });
}

export function idbBlobBackend(vaultId: string): BlobBackend {
	return {
		appendStaged: (key, bytes) => appendStaged(vaultId, key, bytes),
		stagedSize: (key) =>
			transact([OBJECTS], "readonly", async (tx) => {
				return (await getObject(tx, vaultId, "staged", key))?.size ?? 0;
			}),
		readStaged: (key, offset, length) => readRange(vaultId, "staged", key, offset, length),
		publishStaged: (hash) => publishStagedAs(vaultId, hash, hash),
		discardStaged: (key) =>
			transact([OBJECTS, PARTS], "readwrite", (tx) => dropObject(tx, vaultId, "staged", key)),
		has: (hash) =>
			transact([OBJECTS], "readonly", async (tx) => {
				return (await getObject(tx, vaultId, "blob", hash)) !== undefined;
			}),
		size: (hash) =>
			transact([OBJECTS], "readonly", async (tx) => {
				return (await getObject(tx, vaultId, "blob", hash))?.size ?? null;
			}),
		read: (hash, offset, length) => readRange(vaultId, "blob", hash, offset, length),
		remove: (hash) =>
			transact([OBJECTS, PARTS], "readwrite", (tx) => dropObject(tx, vaultId, "blob", hash)),
		list: () =>
			transact([OBJECTS], "readonly", async (tx) => {
				const store = tx.objectStore(OBJECTS);
				const range = IDBKeyRange.bound([vaultId, "blob", ""], [vaultId, "blob", []]);
				const [keys, recs] = await Promise.all([
					req(store.getAllKeys(range)),
					req(store.getAll(range)),
				]);
				return keys.map((k, i) => ({
					hash: (k as string[])[2] as string,
					size: (recs[i] as ObjectRecord).size,
				}));
			}),
	};
}

/** Erase every object a vault holds, blobs and staging alike. */
export async function deleteVaultFiles(vaultId: string): Promise<void> {
	await transact([OBJECTS, PARTS], "readwrite", async (tx) => {
		const store = tx.objectStore(OBJECTS);
		// Arrays sort after strings, so [vaultId, []] bounds every [vaultId, kind, name].
		const range = IDBKeyRange.bound([vaultId], [vaultId, []]);
		const [keys, recs] = await Promise.all([
			req(store.getAllKeys(range)),
			req(store.getAll(range)),
		]);
		for (let i = 0; i < keys.length; i++) {
			await req(store.delete(keys[i] as IDBValidKey));
			await req(tx.objectStore(PARTS).delete(partsOf((recs[i] as ObjectRecord).obj)));
		}
	});
}

/** Park plaintext for another context to pick up. Returns the key to hand it by. */
export async function putHandoff(blob: Blob): Promise<string> {
	const token = globalThis.crypto.randomUUID();
	await transact([HANDOFF], "readwrite", async (tx) => {
		await req(tx.objectStore(HANDOFF).put({ blob, at: Date.now() } satisfies HandoffRecord, token));
	});
	return token;
}

export async function readHandoff(token: string): Promise<Blob | null> {
	return transact([HANDOFF], "readonly", async (tx) => {
		const rec = (await req(tx.objectStore(HANDOFF).get(token))) as HandoffRecord | undefined;
		return rec?.blob ?? null;
	});
}

export async function dropHandoff(token: string): Promise<void> {
	await transact([HANDOFF], "readwrite", async (tx) => {
		await req(tx.objectStore(HANDOFF).delete(token));
	});
}

/**
 * Drop parked plaintext. Every entry by default, for a lock or a browser start; with an age,
 * only what has sat longer than that, which no live handoff does.
 */
export async function clearHandoffs(olderThanMs?: number): Promise<void> {
	await transact([HANDOFF], "readwrite", async (tx) => {
		const store = tx.objectStore(HANDOFF);
		if (olderThanMs === undefined) {
			await req(store.clear());
			return;
		}
		const cutoff = Date.now() - olderThanMs;
		const [keys, recs] = await Promise.all([req(store.getAllKeys()), req(store.getAll())]);
		for (let i = 0; i < keys.length; i++) {
			if ((recs[i] as HandoffRecord).at < cutoff) await req(store.delete(keys[i] as IDBValidKey));
		}
	});
}
