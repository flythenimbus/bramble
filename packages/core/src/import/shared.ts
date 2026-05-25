import { strFromU8 } from "fflate";
import {
	type CustomField,
	type EntryData,
	type EntryType,
	entryDataSchema,
} from "../hooks/useVault";
import type { ImportResult } from "./types";

export interface RawField {
	key: string;
	value: string;
	hidden?: boolean;
}

export function toCustomFields(pairs: RawField[]): CustomField[] | undefined {
	const out: CustomField[] = [];
	for (const { key, value, hidden } of pairs) {
		if (!key || !value) continue;
		out.push(hidden ? { key, value, hidden: true } : { key, value });
	}
	return out.length ? out : undefined;
}

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

export function asText(raw: string | Uint8Array): string {
	return typeof raw === "string" ? raw : strFromU8(raw);
}

export function asBytes(raw: string | Uint8Array): Uint8Array {
	if (typeof raw === "string") throw new Error("expected file bytes, received text");
	return raw;
}
