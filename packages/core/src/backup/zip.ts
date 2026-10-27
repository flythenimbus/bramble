// The ZIP container for backups with attachments: stored (never deflated) entries, written as a
// layout of parts rather than one buffer, and read back through a random-access source. Our own
// rather than fflate's, because both of fflate's halves hold the whole archive in memory, and a
// backup must carry a vault of any size. See docs/cloud-storage-backups.md.
//
// Only what Bramble writes is accepted on the way back in: STORE, no encryption, no data
// descriptors, no comment, one archive per file. ZIP64 is used exactly where a size or offset
// needs it, so a small backup is a plain ZIP any tool opens and a large one still is.

/** Where an archive's bytes come from: small header bytes, or a stored file read on demand. */
export type ArchivePart =
	| { kind: "bytes"; bytes: Uint8Array }
	| { kind: "blob"; hash: string; size: number };

/** A whole archive, described rather than built. `size` is exact before any part is read. */
export interface ArchiveLayout {
	size: number;
	parts: ArchivePart[];
}

export interface ZipEntryInput {
	name: string;
	size: number;
	crc: number;
	data: ArchivePart;
}

/** Thrown for anything that is not exactly the archive Bramble writes. */
export class ZipFormatError extends Error {}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const LOCATOR_SIG = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const EOCD_LEN = 22;
const EOCD64_LEN = 56;
const LOCATOR_LEN = 20;
// A fixed timestamp (2000-01-01 00:00), as DOS fields, so identical content packs to identical
// bytes in every timezone.
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
// "Made by" Unix, spec 4.5; an ordinary rw-r--r-- file, so extracting one is not surprising.
const MADE_BY = (3 << 8) | 45;
const UNIX_FILE_ATTRS = (0o100644 << 16) >>> 0;

let crcTable: Uint32Array | null = null;
function table(): Uint32Array {
	if (crcTable) return crcTable;
	crcTable = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		crcTable[n] = c >>> 0;
	}
	return crcTable;
}

/** Incremental CRC-32 (the ZIP polynomial). Start from 0, feed every chunk, read `value`. */
export function crc32(): { update(bytes: Uint8Array): void; readonly value: number } {
	const t = table();
	let c = MAX32;
	return {
		update(bytes) {
			for (let i = 0; i < bytes.length; i++)
				c = (t[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
		},
		get value() {
			return (c ^ MAX32) >>> 0;
		},
	};
}

class Writer {
	readonly bytes: Uint8Array;
	private view: DataView;
	private at = 0;
	constructor(length: number) {
		this.bytes = new Uint8Array(length);
		this.view = new DataView(this.bytes.buffer);
	}
	u16(v: number) {
		this.view.setUint16(this.at, v, true);
		this.at += 2;
	}
	u32(v: number) {
		this.view.setUint32(this.at, v >>> 0, true);
		this.at += 4;
	}
	u64(v: number) {
		this.view.setBigUint64(this.at, BigInt(v), true);
		this.at += 8;
	}
	raw(b: Uint8Array) {
		this.bytes.set(b, this.at);
		this.at += b.length;
	}
}

const ascii = (s: string) => new TextEncoder().encode(s);

/**
 * Lay out a stored ZIP of these entries, in this order. `forceZip64` writes every ZIP64 field
 * whether needed or not, so the large-archive path can be tested without gigabytes.
 */
export function layoutZip(
	entries: ZipEntryInput[],
	opts: { forceZip64?: boolean } = {},
): ArchiveLayout {
	const parts: ArchivePart[] = [];
	const push = (part: ArchivePart) => {
		const last = parts[parts.length - 1];
		if (part.kind === "bytes" && last?.kind === "bytes") {
			const merged = new Uint8Array(last.bytes.length + part.bytes.length);
			merged.set(last.bytes);
			merged.set(part.bytes, last.bytes.length);
			parts[parts.length - 1] = { kind: "bytes", bytes: merged };
		} else parts.push(part);
	};

	const central: { name: Uint8Array; size: number; crc: number; offset: number }[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = ascii(entry.name);
		const big = opts.forceZip64 || entry.size >= MAX32;
		const header = new Writer(30 + name.length + (big ? 20 : 0));
		header.u32(LOCAL_SIG);
		header.u16(big ? 45 : 10);
		header.u16(0);
		header.u16(0); // stored
		header.u16(DOS_TIME);
		header.u16(DOS_DATE);
		header.u32(entry.crc);
		header.u32(big ? MAX32 : entry.size);
		header.u32(big ? MAX32 : entry.size);
		header.u16(name.length);
		header.u16(big ? 20 : 0);
		header.raw(name);
		if (big) {
			header.u16(ZIP64_EXTRA);
			header.u16(16);
			header.u64(entry.size);
			header.u64(entry.size);
		}
		push({ kind: "bytes", bytes: header.bytes });
		push(entry.data);
		central.push({ name, size: entry.size, crc: entry.crc, offset });
		offset += header.bytes.length + entry.size;
	}

	const cdOffset = offset;
	let cdSize = 0;
	for (const c of central) {
		const sizeBig = opts.forceZip64 || c.size >= MAX32;
		const offsetBig = opts.forceZip64 || c.offset >= MAX32;
		const extra = (sizeBig ? 16 : 0) + (offsetBig ? 8 : 0);
		const h = new Writer(46 + c.name.length + (extra ? 4 + extra : 0));
		h.u32(CENTRAL_SIG);
		h.u16(MADE_BY);
		h.u16(sizeBig || offsetBig ? 45 : 10);
		h.u16(0);
		h.u16(0);
		h.u16(DOS_TIME);
		h.u16(DOS_DATE);
		h.u32(c.crc);
		h.u32(sizeBig ? MAX32 : c.size);
		h.u32(sizeBig ? MAX32 : c.size);
		h.u16(c.name.length);
		h.u16(extra ? 4 + extra : 0);
		h.u16(0); // comment
		h.u16(0); // disk
		h.u16(0); // internal attributes
		h.u32(UNIX_FILE_ATTRS);
		h.u32(offsetBig ? MAX32 : c.offset);
		h.raw(c.name);
		if (extra) {
			h.u16(ZIP64_EXTRA);
			h.u16(extra);
			if (sizeBig) {
				h.u64(c.size);
				h.u64(c.size);
			}
			if (offsetBig) h.u64(c.offset);
		}
		push({ kind: "bytes", bytes: h.bytes });
		cdSize += h.bytes.length;
	}

	const end = cdOffset + cdSize;
	const zip64 =
		opts.forceZip64 ||
		entries.length >= MAX16 ||
		cdSize >= MAX32 ||
		cdOffset >= MAX32 ||
		end >= MAX32;
	const tail = new Writer((zip64 ? EOCD64_LEN + LOCATOR_LEN : 0) + EOCD_LEN);
	if (zip64) {
		tail.u32(EOCD64_SIG);
		tail.u64(EOCD64_LEN - 12);
		tail.u16(MADE_BY);
		tail.u16(45);
		tail.u32(0);
		tail.u32(0);
		tail.u64(entries.length);
		tail.u64(entries.length);
		tail.u64(cdSize);
		tail.u64(cdOffset);
		tail.u32(LOCATOR_SIG);
		tail.u32(0);
		tail.u64(end);
		tail.u32(1);
	}
	tail.u32(EOCD_SIG);
	tail.u16(0);
	tail.u16(0);
	tail.u16(zip64 ? MAX16 : entries.length);
	tail.u16(zip64 ? MAX16 : entries.length);
	tail.u32(zip64 ? MAX32 : cdSize);
	tail.u32(zip64 ? MAX32 : cdOffset);
	tail.u16(0);
	push({ kind: "bytes", bytes: tail.bytes });

	return { size: end + tail.bytes.length, parts };
}

/** Bytes read on demand from wherever an archive is: a picked file, a buffer, a blob store. */
export interface RandomAccessSource {
	size: number;
	read(offset: number, length: number): Promise<Uint8Array>;
}

export function bytesSource(bytes: Uint8Array): RandomAccessSource {
	return {
		size: bytes.length,
		read: async (offset, length) => bytes.subarray(offset, offset + length),
	};
}

/** One stored entry: where its data starts in the archive, and how long it is. */
export interface ZipEntry {
	name: string;
	offset: number;
	size: number;
	crc: number;
}

class Reader {
	private view: DataView;
	at = 0;
	constructor(private bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}
	need(n: number) {
		if (this.at + n > this.bytes.length) throw new ZipFormatError("truncated record");
	}
	u16() {
		this.need(2);
		const v = this.view.getUint16(this.at, true);
		this.at += 2;
		return v;
	}
	u32() {
		this.need(4);
		const v = this.view.getUint32(this.at, true);
		this.at += 4;
		return v;
	}
	u64() {
		this.need(8);
		const v = this.view.getBigUint64(this.at, true);
		this.at += 8;
		if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipFormatError("size out of range");
		return Number(v);
	}
	raw(n: number) {
		this.need(n);
		const out = this.bytes.subarray(this.at, this.at + n);
		this.at += n;
		return out;
	}
}

/** The largest central directory accepted: tens of thousands of entries, and no more. */
const MAX_DIRECTORY = 64 * 1024 * 1024;

/** Read the ZIP64 extra field's values that the fixed fields marked as overflowed. */
function zip64Fields(
	extra: Uint8Array,
	want: { size: boolean; offset: boolean },
): { size?: number; offset?: number } {
	const r = new Reader(extra);
	while (r.at < extra.length) {
		const id = r.u16();
		const len = r.u16();
		const body = new Reader(r.raw(len));
		if (id !== ZIP64_EXTRA) continue;
		const out: { size?: number; offset?: number } = {};
		if (want.size) {
			const uncompressed = body.u64();
			const compressed = body.u64();
			if (uncompressed !== compressed) throw new ZipFormatError("compressed entry");
			out.size = uncompressed;
		}
		if (want.offset) out.offset = body.u64();
		return out;
	}
	if (want.size || want.offset) throw new ZipFormatError("missing ZIP64 field");
	return {};
}

/**
 * The entries of a stored ZIP, checked against the rules above and against each other: every
 * local header agrees with its directory entry, and no two entries' data overlap, so each byte
 * of the archive belongs to at most one file.
 */
export async function readZipDirectory(src: RandomAccessSource): Promise<ZipEntry[]> {
	if (src.size < EOCD_LEN) throw new ZipFormatError("too short");
	const eocd = new Reader(await src.read(src.size - EOCD_LEN, EOCD_LEN));
	if (eocd.u32() !== EOCD_SIG) throw new ZipFormatError("no end record (or a comment)");
	if (eocd.u16() !== 0 || eocd.u16() !== 0) throw new ZipFormatError("multi-disk archive");
	let count = eocd.u16();
	if (eocd.u16() !== count) throw new ZipFormatError("inconsistent entry count");
	let cdSize = eocd.u32();
	let cdOffset = eocd.u32();
	if (eocd.u16() !== 0) throw new ZipFormatError("comment");
	let directoryEnd = src.size - EOCD_LEN;

	if (count === MAX16 || cdSize === MAX32 || cdOffset === MAX32) {
		if (src.size < EOCD_LEN + LOCATOR_LEN + EOCD64_LEN) throw new ZipFormatError("too short");
		const loc = new Reader(await src.read(src.size - EOCD_LEN - LOCATOR_LEN, LOCATOR_LEN));
		if (loc.u32() !== LOCATOR_SIG || loc.u32() !== 0) throw new ZipFormatError("no ZIP64 locator");
		const eocd64At = loc.u64();
		if (loc.u32() !== 1) throw new ZipFormatError("multi-disk archive");
		if (eocd64At + EOCD64_LEN !== src.size - EOCD_LEN - LOCATOR_LEN) {
			throw new ZipFormatError("misplaced ZIP64 end record");
		}
		const e = new Reader(await src.read(eocd64At, EOCD64_LEN));
		if (e.u32() !== EOCD64_SIG || e.u64() !== EOCD64_LEN - 12) {
			throw new ZipFormatError("bad ZIP64 end record");
		}
		e.u16();
		e.u16();
		if (e.u32() !== 0 || e.u32() !== 0) throw new ZipFormatError("multi-disk archive");
		count = e.u64();
		if (e.u64() !== count) throw new ZipFormatError("inconsistent entry count");
		cdSize = e.u64();
		cdOffset = e.u64();
		directoryEnd = eocd64At;
	}
	if (cdOffset + cdSize !== directoryEnd) throw new ZipFormatError("misplaced directory");
	if (cdSize > MAX_DIRECTORY) throw new ZipFormatError("directory too large");

	const cd = new Reader(await src.read(cdOffset, cdSize));
	const entries: ZipEntry[] = [];
	// Header start to data end, per entry, for the overlap check.
	const spans: { start: number; end: number }[] = [];
	const names = new Set<string>();
	for (let i = 0; i < count; i++) {
		if (cd.u32() !== CENTRAL_SIG) throw new ZipFormatError("bad directory entry");
		cd.u16(); // made by
		cd.u16(); // version needed
		const flags = cd.u16();
		if (flags & ~0x0800) throw new ZipFormatError("encrypted or streamed entry");
		if (cd.u16() !== 0) throw new ZipFormatError("compressed entry");
		cd.u16();
		cd.u16();
		const crc = cd.u32();
		const compressed = cd.u32();
		const uncompressed = cd.u32();
		if (compressed !== uncompressed) throw new ZipFormatError("compressed entry");
		const nameLen = cd.u16();
		const extraLen = cd.u16();
		const commentLen = cd.u16();
		if (cd.u16() !== 0) throw new ZipFormatError("multi-disk archive");
		cd.u16();
		cd.u32();
		const headerAt = cd.u32();
		const nameBytes = cd.raw(nameLen);
		const extra = cd.raw(extraLen);
		cd.raw(commentLen);
		const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
		if (names.has(name)) throw new ZipFormatError("the same file twice");
		names.add(name);
		const big = zip64Fields(extra, { size: uncompressed === MAX32, offset: headerAt === MAX32 });
		const size = big.size ?? uncompressed;
		const localAt = big.offset ?? headerAt;

		// The local header must agree, and the data starts after IT, not after the directory's
		// idea of it: a reader that trusted only one of the two is how two tools come to disagree
		// about what an archive holds.
		const local = new Reader(await src.read(localAt, Math.min(30, src.size - localAt)));
		if (local.u32() !== LOCAL_SIG) throw new ZipFormatError("bad local header");
		local.u16();
		if (local.u16() & ~0x0800) throw new ZipFormatError("encrypted or streamed entry");
		if (local.u16() !== 0) throw new ZipFormatError("compressed entry");
		local.u16();
		local.u16();
		if (local.u32() !== crc) throw new ZipFormatError("local header disagrees");
		const localCompressed = local.u32();
		const localSize = local.u32();
		const localNameLen = local.u16();
		const localExtraLen = local.u16();
		const tail = new Reader(await src.read(localAt + 30, localNameLen + localExtraLen));
		const localName = tail.raw(localNameLen);
		if (localNameLen !== nameLen || localName.some((b, j) => b !== nameBytes[j])) {
			throw new ZipFormatError("local header disagrees");
		}
		const localExtra = tail.raw(localExtraLen);
		if (localSize === MAX32 || localCompressed === MAX32) {
			if (zip64Fields(localExtra, { size: true, offset: false }).size !== size) {
				throw new ZipFormatError("local header disagrees");
			}
		} else if (localSize !== size || localCompressed !== size) {
			throw new ZipFormatError("local header disagrees");
		}
		const offset = localAt + 30 + localNameLen + localExtraLen;
		if (offset + size > cdOffset) throw new ZipFormatError("entry runs into the directory");
		entries.push({ name, offset, size, crc });
		spans.push({ start: localAt, end: offset + size });
	}
	if (cd.at !== cdSize) throw new ZipFormatError("directory has trailing bytes");

	spans.sort((a, b) => a.start - b.start);
	for (let i = 1; i < spans.length; i++) {
		if ((spans[i] as { start: number }).start < (spans[i - 1] as { end: number }).end) {
			throw new ZipFormatError("entries overlap");
		}
	}
	return entries;
}
