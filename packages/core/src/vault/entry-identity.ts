// Is this entry the same credential as one already in the vault?
//
// Used to spot a file being imported twice. The comparison is over the entry's CONTENT: two
// entries match when everything the file could carry matches, ignoring what the vault stamped
// on afterwards.
//
// Those stamps are why a naive whole-object compare finds nothing. `importMany` mints a fresh
// `id` and defaults `updatedAt` to the moment of import, so the same file imported twice
// produces two objects that differ before any content is examined. The same applies nested:
// a PasskeyCredential carries its own `createdAt`, which the Bitwarden importer falls back to
// `Date.now()` for when the export has no creation date.

import type { EntryData } from "../hooks/useVault";

/**
 * Vault bookkeeping, stripped at any depth. `createdAt` is included because only some
 * importers can recover it from the file; leaving it in would make matching work for Bitwarden
 * and quietly fail for every format that doesn't carry a creation date.
 */
const METADATA_KEYS = new Set(["id", "createdAt", "updatedAt", "lastUsedAt", "breach"]);

/**
 * Canonical JSON: object keys sorted so a re-ordered but identical entry still matches (stored
 * entries come back through `normalizeEntryData`, which rebuilds them), `undefined` dropped so
 * an absent field and an explicitly-undefined one agree, and ARRAY ORDER PRESERVED because
 * urls in a different order really is a different entry.
 */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		if (METADATA_KEYS.has(key)) continue;
		const v = (value as Record<string, unknown>)[key];
		if (v === undefined) continue;
		out[key] = canonical(v);
	}
	return out;
}

/** A string that is equal for two entries holding the same credential. */
export function entryContentKey(entry: EntryData): string {
	return JSON.stringify(canonical(entry));
}

/**
 * Split incoming entries into the ones worth importing and a count of those the vault already
 * holds. Duplicates WITHIN the incoming batch collapse too, so a file that repeats an entry
 * imports it once.
 */
export function splitAlreadyImported(
	existing: readonly EntryData[],
	incoming: readonly EntryData[],
): { fresh: EntryData[]; duplicates: number } {
	const seen = new Set(existing.map(entryContentKey));
	const fresh: EntryData[] = [];
	let duplicates = 0;
	for (const entry of incoming) {
		const key = entryContentKey(entry);
		if (seen.has(key)) {
			duplicates++;
			continue;
		}
		seen.add(key);
		fresh.push(entry);
	}
	return { fresh, duplicates };
}
