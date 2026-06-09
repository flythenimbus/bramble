import { strFromU8 } from "fflate";
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
	const byType: Partial<Record<EntryType, number>> = {};
	for (const e of imported) byType[e.type] = (byType[e.type] ?? 0) + 1;
	return { imported, byType, skipped: skipped + dropped, warnings };
}

/** Normalize a string-or-bytes input to text. */
export function asText(raw: string | Uint8Array): string {
	return typeof raw === "string" ? raw : strFromU8(raw);
}

/** Normalize a string-or-bytes input to bytes; throws if handed text. */
export function asBytes(raw: string | Uint8Array): Uint8Array {
	if (typeof raw === "string") throw new Error("expected file bytes, received text");
	return raw;
}

// Decompressed-size ceiling for zip importers: the 50 MB input cap doesn't stop
// a high-ratio zip bomb, so bound the decompressed total too.
const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;

/** Throw if an unzip result's total decompressed size exceeds the cap. Run before any further parsing. */
export function assertUnzipUnderCap(files: Record<string, Uint8Array>): void {
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
