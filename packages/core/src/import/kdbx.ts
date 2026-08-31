import type { KdbxRawEntry } from "../adapters/crypto";
import type { EntryData } from "../hooks/useVault";
import { mapKeepassEntry } from "./keepass";
import { type ConversionTally, systemicFailureWarning } from "./passkey-fields";
import type { RawField } from "./shared";
import { summarize } from "./shared";
import type { ImportParserContext, ImportResult } from "./types";

/**
 * Map decrypted KDBX entries (opened in WASM) to an ImportResult, through the same per-entry
 * mapper the XML export uses so a passkey converts identically whichever file it arrived in.
 *
 * Async and warning-carrying because of the passkeys: this path used to hardcode an empty
 * warnings array, which meant nothing the .kdbx import skipped could ever be reported.
 */
export async function kdbxEntriesToResult(
	entries: KdbxRawEntry[],
	context: ImportParserContext,
): Promise<ImportResult> {
	const warnings: string[] = [];
	const tally: ConversionTally = { converted: 0, failed: 0 };
	const importedAt = Date.now();
	const mapped: EntryData[] = [];
	for (const entry of entries) {
		const fields: RawField[] = entry.strings.map((s) => ({
			key: s.key,
			value: s.value,
			hidden: s.protected,
		}));
		mapped.push(await mapKeepassEntry(fields, context, importedAt, warnings, tally));
	}
	const systemic = systemicFailureWarning(tally, "database");
	if (systemic) warnings.push(systemic);
	return summarize(mapped, 0, warnings);
}
