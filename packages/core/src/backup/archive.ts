// A backup file, with or without attachments. See docs/cloud-storage-backups.md and
// docs/file-attachments.md.
//
// A vault with no attachments is backed up exactly as it always was: its raw VLT1 blob, byte
// for byte. A vault with attachments is backed up as ONE self-contained ZIP holding that same
// blob plus every attachment's sealed file, so a single downloaded file restores everything
// with nothing else to reach. The extension stays `.bramble` either way (the way `.1pux` is a
// ZIP with its own), and readers tell the two apart by their first bytes, never by the name.
//
// A backup is complete or it is not made. There is no size limit and no partial archive: a
// vault whose attachments are not all on this device, or whose list cannot be read, is not
// backed up until it can be backed up whole, and says why (BackupBlocked). The archive is laid
// out, not built, so its size is unbounded by memory: providers read it in parts.
//
// The ZIP needs no trust of its own. The vault inside authenticates itself (AEAD), and every
// attachment is named by the hash of its own bytes, which the blob store re-checks on the way
// in. So a tampered archive can fail an attachment, but it cannot deliver wrong data.

import { BLOB_HASH_RE, decodeEntriesPayload, type FileRecord } from "../sync/entries-payload";
import { liveFiles } from "../sync/vault-merge";
import { bytesToBase64 } from "../util/bytes";
import type { BlobStore } from "../vault/blob-store";
import { decodeVaultBlob } from "../vault-format";
import { sha256Hex } from "./sigv4";
import {
	type ArchiveLayout,
	bytesSource,
	crc32,
	layoutZip,
	type RandomAccessSource,
	readZipDirectory,
	type ZipEntryInput,
	ZipFormatError,
} from "./zip";

/** The vault's own blob inside an archive. */
export const VAULT_ENTRY = "vault.bramble";
const BLOB_PREFIX = "blobs/";

/**
 * The largest single attachment. Not a backup limit (backups have none) but a practical one:
 * every attachment is replicated to every device, and the extension opens one into memory.
 */
export const MAX_ATTACHMENT_BYTES = 90 * 1024 * 1024;

/** The largest vault blob read whole. Far past any real vault; it only stops a stray multi-GB
 * file from being read into memory on its way to failing the format check. */
const MAX_VAULT_BYTES = 512 * 1024 * 1024;

/** How much of an attachment is read at a time, for CRCs and restores. */
const READ_CHUNK = 1024 * 1024;

/** A backup's bytes, read on demand. */
export type BackupBody = RandomAccessSource;

/**
 * Why a vault cannot be backed up whole right now. Never a reason to back up part of it.
 * - `locked`: its attachment list is sealed and no key in hand opens it (and none is cached for
 *   this exact vault), so what a complete backup holds cannot be known yet.
 * - `missing`: it lists attachments whose files are not on this device yet.
 */
export type BackupBlocked = { reason: "locked" } | { reason: "missing"; count: number };

/** Thrown for a backup asked of a vault that cannot be backed up whole (see BackupBlocked). */
export class BackupIncompleteError extends Error {
	constructor(readonly blocked: BackupBlocked) {
		super(
			blocked.reason === "missing"
				? `${blocked.count} attachment(s) are not on this device yet`
				: "the vault's attachment list cannot be read while it is locked",
		);
	}
}

/**
 * A vault's attachment list as last read, kept so a locked vault can still be planned. Valid
 * only for the exact vault bytes it was read from: no write reaches a vault without its key, so
 * while those bytes are unchanged the list is exactly right, and once they change it is ignored.
 * Holds only blob hashes, which name the files already on this device's disk.
 */
export interface AttachmentListCache {
	get(): Promise<{ vaultHash: string; hashes: string[] } | null>;
	set(list: { vaultHash: string; hashes: string[] }): Promise<void>;
}

export interface BuildBackupInput {
	/** The vault's sealed VLT1 blob, as stored. */
	vault: Uint8Array;
	/** This vault's attachment store, or null where the platform holds none. */
	blobs: BlobStore | null;
	/** Opens the vault's entries payload, to learn its attachment list. Throws when the key in
	 * hand is not this vault's (another vault's, or none), which means "unknown", not "none". */
	decryptWithVek(iv: string, ciphertext: string): Promise<string>;
	/** Where a platform that backs up locked vaults keeps their lists. */
	listCache?: AttachmentListCache;
}

/** The vault's live attachments, or null when its payload cannot be opened with this key. */
async function readAttachmentList(input: BuildBackupInput): Promise<FileRecord[] | null> {
	try {
		const blob = decodeVaultBlob(input.vault);
		if (blob.entriesCiphertext.length === 0) return [];
		const json = await input.decryptWithVek(
			bytesToBase64(blob.entriesIv),
			bytesToBase64(blob.entriesCiphertext),
		);
		return liveFiles(decodeEntriesPayload(json));
	} catch {
		return null;
	}
}

/** Fingerprint of a backup: the vault alone, or the vault plus the attachments it carries. */
export async function backupFingerprint(
	vault: Uint8Array,
	attachmentHashes: Iterable<string>,
): Promise<string> {
	const vaultHash = await sha256Hex(vault);
	const hashes = [...new Set(attachmentHashes)].sort();
	if (hashes.length === 0) return vaultHash;
	return sha256Hex(`${vaultHash}:${hashes.join(",")}`);
}

/** A layout read on demand: header bytes from memory, attachments from the store. */
export function layoutSource(layout: ArchiveLayout, blobs: BlobStore | null): BackupBody {
	const starts: number[] = [];
	let at = 0;
	for (const part of layout.parts) {
		starts.push(at);
		at += part.kind === "bytes" ? part.bytes.length : part.size;
	}
	return {
		size: layout.size,
		async read(offset, length) {
			if (offset < 0 || length < 0 || offset + length > layout.size) {
				throw new RangeError("read past the end of the backup");
			}
			const out = new Uint8Array(length);
			let written = 0;
			// The last part starting at or before `offset`.
			let lo = 0;
			let hi = starts.length - 1;
			while (lo < hi) {
				const mid = (lo + hi + 1) >> 1;
				if ((starts[mid] as number) <= offset) lo = mid;
				else hi = mid - 1;
			}
			for (let i = lo; written < length; i++) {
				const part = layout.parts[i];
				if (!part) throw new RangeError("read past the end of the backup");
				const partStart = starts[i] as number;
				const partSize = part.kind === "bytes" ? part.bytes.length : part.size;
				const from = Math.max(0, offset + written - partStart);
				const take = Math.min(partSize - from, length - written);
				if (take <= 0) continue;
				if (part.kind === "bytes") {
					out.set(part.bytes.subarray(from, from + take), written);
				} else {
					if (!blobs) throw new Error("this backup needs an attachment store");
					const chunk = await blobs.read(part.hash, from, take);
					if (chunk.length !== take) throw new Error("an attachment is shorter than recorded");
					out.set(chunk, written);
				}
				written += take;
			}
			return out;
		},
	};
}

/** CRC-32 of one stored blob, read in chunks. */
async function blobCrc(blobs: BlobStore, hash: string, size: number): Promise<number> {
	const crc = crc32();
	for (let at = 0; at < size; at += READ_CHUNK) {
		crc.update(await blobs.read(hash, at, Math.min(READ_CHUNK, size - at)));
	}
	return crc.value;
}

/** Lay out the archive of a vault and these held attachments. Reads each attachment once,
 * for its CRC; nothing is kept. */
async function layoutArchive(
	vault: Uint8Array,
	blobs: BlobStore,
	hashes: string[],
): Promise<ArchiveLayout> {
	const vaultCrc = crc32();
	vaultCrc.update(vault);
	const entries: ZipEntryInput[] = [
		{
			name: VAULT_ENTRY,
			size: vault.length,
			crc: vaultCrc.value,
			data: { kind: "bytes", bytes: vault },
		},
	];
	for (const hash of [...hashes].sort()) {
		const size = await blobs.size(hash);
		if (size === null) throw new BackupIncompleteError({ reason: "missing", count: 1 });
		entries.push({
			name: `${BLOB_PREFIX}${hash}`,
			size,
			crc: await blobCrc(blobs, hash, size),
			data: { kind: "blob", hash, size },
		});
	}
	return layoutZip(entries);
}

/**
 * What a backup would contain, without reading any attachment. Enough to decide whether a
 * backup is needed at all: the fingerprint needs the attachments' hashes, never their bytes.
 */
export interface BackupPlan {
	fingerprint: string;
	/** Attachments a backup carries. */
	attachments: number;
	/** Set when the vault cannot be backed up whole. Then nothing may be uploaded or saved. */
	blocked?: BackupBlocked;
	/** The file itself. Throws BackupIncompleteError when blocked. */
	body(): Promise<BackupBody>;
}

/**
 * Plan one vault's backup. Deciding and packing are separate on purpose: a scheduled run that
 * finds nothing changed must not read every attachment just to learn that.
 */
export async function planBackup(input: BuildBackupInput): Promise<BackupPlan> {
	const vaultOnly = async (): Promise<BackupPlan> => ({
		fingerprint: await backupFingerprint(input.vault, []),
		attachments: 0,
		body: async () => bytesSource(input.vault),
	});
	const blocked = async (why: BackupBlocked): Promise<BackupPlan> => ({
		fingerprint: await backupFingerprint(input.vault, []),
		attachments: 0,
		blocked: why,
		body: async () => {
			throw new BackupIncompleteError(why);
		},
	});

	const blobs = input.blobs;
	if (!blobs) return vaultOnly();

	const vaultHash = await sha256Hex(input.vault);
	let hashes: string[];
	const listed = await readAttachmentList(input);
	if (listed) {
		// Deduplicated by address: two records naming one file pack it once.
		hashes = [...new Set(listed.map((r) => r.hash))];
		await input.listCache?.set({ vaultHash, hashes }).catch(() => {});
	} else {
		// No key opens the list. Only a list read from these exact bytes stands in for it;
		// anything else, including an empty store, says nothing about what the vault names.
		const cached = await input.listCache?.get().catch(() => null);
		if (!cached || cached.vaultHash !== vaultHash) return blocked({ reason: "locked" });
		hashes = cached.hashes;
	}
	if (hashes.length === 0) return vaultOnly();

	let missing = 0;
	for (const hash of hashes) if (!(await blobs.has(hash))) missing++;
	if (missing > 0) return blocked({ reason: "missing", count: missing });

	return {
		fingerprint: await backupFingerprint(input.vault, hashes),
		attachments: hashes.length,
		body: async () => layoutSource(await layoutArchive(input.vault, blobs, hashes), blobs),
	};
}

/**
 * Plan and lay out in one go, for a writer that always writes: "Back up now" and "Export a
 * backup". Shared by every writer, so a vault is packed the same way whichever made the file.
 * Throws BackupIncompleteError rather than write a backup that is not whole.
 */
export async function buildBackup(
	input: BuildBackupInput,
): Promise<{ body: BackupBody; fingerprint: string; attachments: number }> {
	const plan = await planBackup(input);
	return { body: await plan.body(), fingerprint: plan.fingerprint, attachments: plan.attachments };
}

/** One attachment inside an archive, located but not read. */
export interface ArchivedAttachment {
	hash: string;
	offset: number;
	size: number;
}

/** A backup file, opened. Attachments stay where they are until restored. */
export type BackupContents =
	| { kind: "vault"; vault: Uint8Array }
	| { kind: "archive"; vault: Uint8Array; attachments: ArchivedAttachment[] };

/** Thrown for an archive that is not exactly what `buildBackup` writes. */
export class BackupArchiveError extends Error {}

function isZipMagic(head: Uint8Array): boolean {
	return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4;
}

/**
 * Open a backup file through a random-access source, so a backup of any size is read without
 * holding it. A plain vault comes back whole, for the caller's VLT1 checks; an archive is read
 * strictly and refused whole if anything in it is not what `buildBackup` writes.
 *
 * Strict because this is untrusted input (a backup can come from anywhere, including a bucket
 * someone else can write to), and every rule closes a specific hole:
 * - only `vault.bramble` and `blobs/<64 lowercase hex>` are accepted, which rules out path
 *   traversal and anything smuggled alongside;
 * - duplicate names are refused, since two ZIP readers disagreeing about which file is "the"
 *   vault is a classic trick;
 * - entries must be stored, local headers must agree with the directory, and no two entries'
 *   bytes may overlap (see readZipDirectory).
 */
export async function openBackup(src: RandomAccessSource): Promise<BackupContents> {
	const head = await src.read(0, Math.min(4, src.size));
	if (!isZipMagic(head)) {
		// Refused before any of it is read: too large to be a plain vault backup.
		if (src.size > MAX_VAULT_BYTES) throw new Error("too large to be a vault");
		return { kind: "vault", vault: await src.read(0, src.size) };
	}

	let entries: Awaited<ReturnType<typeof readZipDirectory>>;
	try {
		entries = await readZipDirectory(src);
	} catch (e) {
		if (e instanceof ZipFormatError) throw new BackupArchiveError("This backup file is damaged.");
		throw e;
	}
	let vaultEntry: (typeof entries)[number] | undefined;
	const attachments: ArchivedAttachment[] = [];
	for (const entry of entries) {
		if (entry.name === VAULT_ENTRY) {
			vaultEntry = entry;
			continue;
		}
		const hash = entry.name.slice(BLOB_PREFIX.length);
		if (!entry.name.startsWith(BLOB_PREFIX) || !BLOB_HASH_RE.test(hash)) {
			throw new BackupArchiveError(
				"This isn't a Bramble backup: it holds a file a Bramble backup never contains.",
			);
		}
		attachments.push({ hash, offset: entry.offset, size: entry.size });
	}
	if (!vaultEntry) throw new BackupArchiveError("This backup file has no vault in it.");
	if (vaultEntry.size > MAX_VAULT_BYTES)
		throw new BackupArchiveError("This backup file is damaged.");
	const vault = await src.read(vaultEntry.offset, vaultEntry.size);
	const crc = crc32();
	crc.update(vault);
	if (crc.value !== vaultEntry.crc) throw new BackupArchiveError("This backup file is damaged.");
	return { kind: "archive", vault, attachments };
}

/**
 * Whether these bytes are a Bramble backup archive (a vault with its attachments). Parsed with
 * the same strict reader rather than judged by the ZIP magic, so an unrelated ZIP is not
 * mistaken for one. For a screen that must turn one away, such as Import, which merges entries
 * and cannot take a whole vault.
 */
export async function isBackupArchive(bytes: Uint8Array): Promise<boolean> {
	if (!isZipMagic(bytes)) return false;
	try {
		return (await openBackup(bytesSource(bytes))).kind === "archive";
	} catch {
		return false;
	}
}

/**
 * Put an archive's attachments into a vault's store, streamed from the archive in chunks. Each
 * is checked against its own name as it is stored, so no vault key is needed here, which
 * matters on mobile, where the one loaded key may not be this vault's yet.
 *
 * A file that fails its check is not stored, and is counted: the vault still lists it, so it
 * shows as missing rather than vanishing, and the caller tells the user to keep the backup.
 */
export async function restoreAttachments(
	blobs: BlobStore,
	src: RandomAccessSource,
	attachments: readonly ArchivedAttachment[],
): Promise<{ restored: number; rejected: number }> {
	let restored = 0;
	let rejected = 0;
	for (const a of attachments) {
		if (await blobs.has(a.hash)) {
			restored++;
			continue;
		}
		const receipt = await blobs.receive(a.hash);
		try {
			// A restore interrupted earlier left a verified-so-far prefix of this same address.
			for (let at = receipt.resumeFrom; at < a.size; at += READ_CHUNK) {
				await receipt.append(await src.read(a.offset + at, Math.min(READ_CHUNK, a.size - at)));
			}
			await receipt.commit();
			restored++;
		} catch {
			await receipt.abort().catch(() => {});
			rejected++;
		}
	}
	return { restored, rejected };
}
