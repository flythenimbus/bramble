import { strFromU8, unzipSync } from "fflate";
import {
	type CustomField,
	type EntryData,
	type EntryType,
	entryDataSchema,
} from "../hooks/useVault";
import type { ImportResult } from "./types";

/** Raw key/value pairs collected by a parser before they become CustomFields. */
export interface RawField {
	key: string;
	value: string;
	hidden?: boolean;
}

/** Build CustomField[] from raw pairs, dropping blank keys/values. Returns undefined when empty. */
export function toCustomFields(pairs: RawField[]): CustomField[] | undefined {
	const out: CustomField[] = [];
	for (const { key, value, hidden } of pairs) {
		if (!key || !value) continue;
		out.push(hidden ? { key, value, hidden: true } : { key, value });
	}
	return out.length ? out : undefined;
}

/** Count entries by type, for the preview's "3 Logins · 1 Payment card" line. */
export function tallyByType(entries: readonly EntryData[]): Partial<Record<EntryType, number>> {
	const byType: Partial<Record<EntryType, number>> = {};
	for (const e of entries) byType[e.type] = (byType[e.type] ?? 0) + 1;
	return byType;
}

/** Validate candidates against EntryData (bad shapes must never reach the vault), drop the rest, tally by type. */
export function summarize(
	candidates: EntryData[],
	skipped: number,
	warnings: string[],
): ImportResult {
	const imported: EntryData[] = [];
	let dropped = 0;
	for (const c of candidates) {
		if (entryDataSchema.safeParse(c).success) imported.push(c);
		else dropped++;
	}
	if (dropped > 0) warnings.push(`${dropped} item(s) had an unexpected shape and were skipped.`);
	return { imported, byType: tallyByType(imported), skipped: skipped + dropped, warnings };
}

/** Best-effort display name for a row with no title: the URL's host, else the raw URL. */
export function hostLabel(url: string): string {
	if (!url) return "";
	try {
		return new URL(url).hostname || url;
	} catch {
		// Bare hosts ("example.com") have no scheme, so URL() throws; retry with one.
		try {
			return new URL(`https://${url}`).hostname || url;
		} catch {
			return url;
		}
	}
}

/** Normalize a string-or-bytes input to text. */
export function asText(raw: string | Uint8Array): string {
	return typeof raw === "string" ? raw : strFromU8(raw);
}

/**
 * RFC 4180 CSV reader: quoted fields may contain commas, newlines and `""`-escaped quotes.
 * Also strips a UTF-8 BOM (Apple's export carries one) and accepts CRLF or LF.
 *
 * Values are returned verbatim, never trimmed: a password may legitimately begin or end with
 * a space. Blank lines are dropped, but a trailing empty field is kept — Apple writes an unset
 * final column as a bare trailing comma (`…,"secret","",`), not as `""`.
 */
export function parseCsvRows(text: string): string[][] {
	const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (quoted) {
			if (c !== '"') field += c;
			else if (src[i + 1] === '"') {
				field += '"';
				i++;
			} else quoted = false;
			continue;
		}
		if (c === '"') quoted = true;
		else if (c === ",") {
			row.push(field);
			field = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && src[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += c;
	}
	// Flush a final row only if the file didn't end on a newline.
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((r) => r.length > 1 || r[0] !== "");
}

/** Normalize a string-or-bytes input to bytes; throws if handed text. */
function asBytes(raw: string | Uint8Array): Uint8Array {
	if (typeof raw === "string") throw new Error("expected file bytes, received text");
	return raw;
}

// Decompressed-size ceiling for zip importers: the 50 MB input cap doesn't stop
// a high-ratio zip bomb, so bound the decompressed total too.
const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;

/**
 * The shape every zipped vendor export shares: unzip under the size cap, find the one file
 * that carries the data, parse it as JSON, and validate it. Only the file name and the error
 * wording differ per vendor, so those are the parameters.
 *
 * `corruptError` covers an unreadable archive (a truncated download); `formatError` covers a
 * readable archive that isn't this vendor's export, which is a different thing to tell a user.
 */
export function readZippedJson<T>(
	raw: string | Uint8Array,
	opts: {
		findData: (files: Record<string, Uint8Array>) => Uint8Array | undefined;
		schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } };
		corruptError: string;
		formatError: string;
	},
): T {
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(asBytes(raw));
	} catch {
		throw new Error(opts.corruptError);
	}
	assertUnzipUnderCap(files);

	const dataFile = opts.findData(files);
	if (!dataFile) throw new Error(opts.formatError);

	let json: unknown;
	try {
		json = JSON.parse(strFromU8(dataFile));
	} catch {
		throw new Error(opts.formatError);
	}
	const parsed = opts.schema.safeParse(json);
	if (!parsed.success) throw new Error(opts.formatError);
	return parsed.data;
}

/** Throw if an unzip result's total decompressed size exceeds the cap. Run before any further parsing. */
function assertUnzipUnderCap(files: Record<string, Uint8Array>): void {
	let total = 0;
	for (const k in files) {
		const f = files[k];
		if (f) total += f.byteLength;
		if (total > MAX_DECOMPRESSED_BYTES) {
			throw new Error(
				`This archive decompresses to more than ${MAX_DECOMPRESSED_BYTES / 1024 / 1024} MB and looks unsafe to process.`,
			);
		}
	}
}
