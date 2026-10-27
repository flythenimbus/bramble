// Every local change to a vault's file attachments: attach, detach, rename. The sibling of
// EntryMutations, with the same shape: each is a transition `(current, input) -> next` whose
// effect is the write, returning the next VaultEntries only after it succeeds. See
// docs/file-attachments.md and CONTEXT.md (VaultEntries, EntryMutations).
//
// Writes go through EntryMutations' own `persist`, so the vault has ONE write path rather than
// a second one racing it. That also means a file change re-encrypts every entry, which is the
// standing cost of the VLT1 container (one `entriesCiphertext`) and not specific to files.

import { MAX_ATTACHMENT_BYTES } from "../backup/archive";
import type { FileManifest, FileRecord, Hlc, HybridClock, Tombstone } from "../sync";
import type { VaultEntries } from "./entry-mutations";

/**
 * Where a picked file's plaintext is, in whatever form the platform hands it over. Opaque to
 * this module: only the FileSealer from the same platform interprets it.
 *
 * `staged` is an IndexedDB key the extension's UI wrote and its offscreen document reads;
 * `path` is a filesystem path a native uniffi call opens directly; `bytes` is the in-memory
 * case, for small files and tests.
 *
 * `blob` is what an `<input type=file>` actually yields, and it exists because no platform
 * here can pick a file by path today: the webview has the bytes and native does not. A
 * platform that needs a path spools the Blob to one first, in slices, so the copy is bounded
 * rather than avoided. See docs/file-attachments.md for why that copy is still there.
 */
export type FileSource =
	| { kind: "blob"; blob: Blob }
	| { kind: "bytes"; bytes: Uint8Array }
	| { kind: "path"; path: string; size?: number }
	| { kind: "staged"; key: string };

/**
 * The plaintext description of a file, sealed into `metaBlob` under the FEK's meta subkey.
 *
 * Just the two fields, both known before sealing starts, which is what lets the caller build
 * this JSON up front and hand Rust a string to seal (the convention `encrypt_entry` follows).
 * The plaintext length is deliberately absent: it is derivable from the record's `size`, and
 * having the caller `stat` the file for it would introduce a value that can disagree with what
 * the sealer actually read. Display uses `size`, which overstates by one 16-byte tag per
 * 256 KiB chunk, or 0.006%.
 */
export interface FileMeta {
	name: string;
	mime: string;
}

/** A file's metadata as the JSON that gets sealed: only what its record cannot say. Built here,
 * because the cores seal the string they are handed and never construct JSON. */
export function encodeFileMeta(meta: FileMeta): string {
	return JSON.stringify({ name: meta.name, mime: meta.mime });
}

/** Opened metadata, checked: anything but what encodeFileMeta writes is refused. */
export function decodeFileMeta(json: string): FileMeta {
	const parsed = JSON.parse(json) as Partial<FileMeta>;
	if (typeof parsed.name !== "string" || typeof parsed.mime !== "string") {
		throw new Error("file metadata is malformed");
	}
	return { name: parsed.name, mime: parsed.mime };
}

/** Plaintext bytes per sealed chunk, and the tag each adds. Mirrors core-rust's files.rs. */
export const FILE_CHUNK_LEN = 256 * 1024;
const FILE_TAG_LEN = 16;

/** A file's length from its sealed length: one tag per chunk, and at least one chunk. */
export function plaintextSize(sealedSize: number): number {
	return (
		sealedSize - FILE_TAG_LEN * Math.max(1, Math.ceil(sealedSize / (FILE_CHUNK_LEN + FILE_TAG_LEN)))
	);
}

/** The manifest fields sealing produces. The blob itself is already in the blob store. */
export interface SealedFile {
	hash: string;
	size: number;
	wrappedFek: string;
	fekIv: string;
	/** The STREAM nonce prefix, base64. Public, like every other IV in the record. */
	noncePrefix: string;
	metaBlob: string;
	metaIv: string;
}

/**
 * The platform seam. Everything that touches raw file bytes lives behind it, so an attachment
 * is never marshalled across an IPC or FFI boundary just to be encrypted: the seal happens
 * where the bytes already are, and only these few hundred bytes of manifest come back.
 */
export interface FileSealer {
	/** Seal a picked file into the blob store and return its manifest fields. */
	seal(source: FileSource, meta: { name: string; mime: string }): Promise<SealedFile>;
	/** Reseal the metadata only, for a rename: same blob, same FEK, same hash. */
	resealMeta(
		record: FileRecord,
		meta: { name: string; mime: string },
	): Promise<Pick<SealedFile, "metaBlob" | "metaIv">>;
	/** Open a record's sealed metadata. */
	describe(record: FileRecord): Promise<FileMeta>;
}

export interface FileMutationsDeps {
	sealer: FileSealer;
	/** EntryMutations' persist, so file writes and entry writes share one path. */
	persist: (next: VaultEntries) => Promise<VaultEntries>;
	clock: () => Promise<HybridClock>;
}

export interface AttachInput {
	source: FileSource;
	name: string;
	mime: string;
	/** The entry this belongs to, or absent for a standalone Files item. */
	entryId?: string;
}

export interface FileMutations {
	attach(current: VaultEntries, input: AttachInput): Promise<VaultEntries>;
	/** Tombstone an attachment. The blob stays until a sweep collects it. */
	detach(current: VaultEntries, fileId: string): Promise<VaultEntries>;
	/** Rename: reseal the metadata and restamp. No bytes move, and the hash is unchanged. */
	rename(current: VaultEntries, fileId: string, name: string): Promise<VaultEntries>;
}

/** Filenames are attacker-influenced on an import path and are shown in the UI. */
const MAX_NAME_LEN = 255;

/** Thrown for a file over MAX_ATTACHMENT_BYTES. A class, not a message: this is a .ts file the
 * Lingui transform does not cover, so the screen supplies the copy. */
export class AttachmentTooLargeError extends Error {
	constructor(readonly limit: number) {
		super(`attachment is over the ${limit}-byte limit`);
	}
}

/** Thrown by an attach to an entry the vault no longer holds: a sync took it meanwhile. */
export class AttachmentEntryGoneError extends Error {
	constructor() {
		super("that entry is no longer in the vault");
	}
}

/** A source's plaintext size, where it is known without reading it. */
function sourceSize(source: FileSource): number | undefined {
	if (source.kind === "blob") return source.blob.size;
	if (source.kind === "bytes") return source.bytes.length;
	if (source.kind === "path") return source.size;
	return undefined;
}

function validateName(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length === 0) throw new Error("file name must not be empty");
	if (trimmed.length > MAX_NAME_LEN) throw new Error(`file name must be at most ${MAX_NAME_LEN}`);
	// A name is sealed and later rendered. Control characters have no legitimate use here, and
	// an embedded newline or a bidi override is how a list row gets spoofed into reading as a
	// different file than it is.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
	if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(trimmed)) {
		throw new Error("file name has a control or bidi-override character");
	}
	return trimmed;
}

interface ManifestLists {
	files: FileRecord[];
	fileTombstones: Tombstone[];
	fileCascades: Tombstone[];
}

/** The manifest as concrete lists, so callers never juggle the optional fields. */
function manifestOf(current: VaultEntries): ManifestLists {
	return {
		files: current.manifest?.files ?? [],
		fileTombstones: current.manifest?.fileTombstones ?? [],
		fileCascades: current.manifest?.fileCascades ?? [],
	};
}

/** Emit the manifest only when it holds something, matching what buildPayload writes. */
function toManifest({
	files,
	fileTombstones,
	fileCascades,
}: ManifestLists): FileManifest | undefined {
	if (files.length === 0 && fileTombstones.length === 0 && fileCascades.length === 0) {
		return undefined;
	}
	return {
		...(files.length > 0 ? { files } : {}),
		...(fileTombstones.length > 0 ? { fileTombstones } : {}),
		...(fileCascades.length > 0 ? { fileCascades } : {}),
	};
}

/**
 * Mark every attachment of these entries as taken by their delete. Exported because
 * EntryMutations owns entry deletion and calls this. The records stay: a mark hides a file only
 * while its entry is gone, so an entry kept from a delete conflict comes back with its files, and
 * a file attached where this delete couldn't see it carries no mark, which keeps the entry from
 * being taken (see mergeEntriesPayload).
 */
export function cascadeFilesForEntries(
	current: VaultEntries,
	entryIds: Set<string>,
	stamp: () => Hlc,
): FileManifest | undefined {
	const m = manifestOf(current);
	const taken = m.files.filter((f) => f.entryId !== undefined && entryIds.has(f.entryId));
	if (taken.length === 0) return current.manifest;
	const ids = new Set(taken.map((f) => f.id));
	return toManifest({
		...m,
		fileCascades: [
			...m.fileCascades.filter((t) => !ids.has(t.id)),
			...taken.map((f) => ({ id: f.id, hlc: stamp() })),
		],
	});
}

/**
 * Check a file and seal it into the store, for an attach or an import. Refused up front, before
 * anything is spooled or sealed: a bad name, or an attachment no backup can carry, which would
 * be listed forever and left out of every one (see MAX_ATTACHMENT_BYTES). The sealed blob is
 * content-addressed, so one whose record is never written is harmless and sweepable.
 */
export async function sealAttachment(
	sealer: FileSealer,
	input: Omit<AttachInput, "entryId">,
): Promise<SealedFile> {
	const name = validateName(input.name);
	const size = sourceSize(input.source);
	if (size !== undefined && size > MAX_ATTACHMENT_BYTES) {
		throw new AttachmentTooLargeError(MAX_ATTACHMENT_BYTES);
	}
	return sealer.seal(input.source, { name, mime: input.mime });
}

/** `current`'s manifest with records for these sealed files added, each stamped by `stamp`. */
export function withSealedFiles(
	current: VaultEntries,
	added: { sealed: SealedFile; entryId?: string }[],
	stamp: () => Hlc,
): FileManifest | undefined {
	const m = manifestOf(current);
	const records: FileRecord[] = added.map(({ sealed, entryId }) => ({
		id: globalThis.crypto.randomUUID(),
		hlc: stamp(),
		...(entryId ? { entryId } : {}),
		...sealed,
	}));
	return toManifest({ ...m, files: [...m.files, ...records] });
}

export function createFileMutations({ sealer, persist, clock }: FileMutationsDeps): FileMutations {
	return {
		async attach(current, input) {
			// A sync may have taken the entry while this was open. A file attached to nothing shown
			// would be held forever and never listed.
			if (input.entryId !== undefined && !current.entries.some((e) => e.id === input.entryId)) {
				throw new AttachmentEntryGoneError();
			}
			// Seal first: a failed seal must not leave a half-written manifest.
			const sealed = await sealAttachment(sealer, input);
			const c = await clock();
			const manifest = withSealedFiles(current, [{ sealed, entryId: input.entryId }], () =>
				c.send(),
			);
			return persist({ ...current, manifest });
		},

		async detach(current, fileId) {
			const m = manifestOf(current);
			if (!m.files.some((f) => f.id === fileId)) return current;
			const c = await clock();
			// The record is dropped and a stamped tombstone kept, matching how an entry delete
			// works: a stale peer that still holds the record loses to the tombstone, and an
			// attach stamped later can still win.
			return persist({
				...current,
				manifest: toManifest({
					...m,
					files: m.files.filter((f) => f.id !== fileId),
					fileTombstones: [...m.fileTombstones, { id: fileId, hlc: c.send() }],
				}),
			});
		},

		async rename(current, fileId, name) {
			const clean = validateName(name);
			const m = manifestOf(current);
			const record = m.files.find((f) => f.id === fileId);
			if (!record) return current;
			const meta = await sealer.describe(record);
			if (meta.name === clean) return current; // no-op: do not rewrite the whole vault
			const resealed = await sealer.resealMeta(record, { name: clean, mime: meta.mime });
			const c = await clock();
			return persist({
				...current,
				manifest: toManifest({
					...m,
					files: m.files.map((f) => (f.id === fileId ? { ...f, ...resealed, hlc: c.send() } : f)),
				}),
			});
		},
	};
}
