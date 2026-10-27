import type { KdbxOpened } from "../adapters/crypto";
import type { EntryData } from "../hooks/useVault";
import { mimeFor } from "../vault/mime";
import { mapKeepassEntry } from "./keepass";
import { type ConversionTally, systemicFailureWarning } from "./passkey-fields";
import type { RawField } from "./shared";
import { summarize } from "./shared";
import type { ImportAttachment, ImportParserContext, ImportResult } from "./types";

/**
 * Map decrypted KDBX entries (opened in WASM) to an ImportResult, through the same per-entry
 * mapper the XML export uses so a passkey converts identically whichever file it arrived in.
 *
 * Async and warning-carrying because of the passkeys: this path used to hardcode an empty
 * warnings array, which meant nothing the .kdbx import skipped could ever be reported.
 */
export async function kdbxEntriesToResult(
	opened: Pick<KdbxOpened, "entries" | "attachments">,
	context: ImportParserContext,
): Promise<ImportResult> {
	const warnings: string[] = [];
	const tally: ConversionTally = { converted: 0, failed: 0 };
	const importedAt = Date.now();
	const mapped: EntryData[] = [];
	const attachments: ImportAttachment[] = [];
	let missing = 0;
	for (const entry of opened.entries) {
		const fields: RawField[] = entry.strings.map((s) => ({
			key: s.key,
			value: s.value,
			hidden: s.protected,
		}));
		const data = await mapKeepassEntry(fields, context, importedAt, warnings, tally);
		mapped.push(data);
		for (const b of entry.binaries ?? []) {
			const held = opened.attachments[b.index];
			if (!held) {
				missing++;
				continue;
			}
			const name = b.name.trim() || "attachment";
			attachments.push({ entry: data, name, mime: mimeFor(name), ...held });
		}
	}
	const systemic = systemicFailureWarning(tally, "database");
	if (systemic) warnings.push(systemic);
	if (missing > 0) {
		warnings.push(`${missing} attachment(s) are named in this database but not stored in it.`);
	}
	const result = summarize(mapped, 0, warnings);
	// An item the summary dropped takes its files with it; say how many rather than lose them.
	const kept = new Set(result.imported);
	const placed = attachments.filter((a) => kept.has(a.entry));
	if (placed.length < attachments.length) {
		const lost = attachments.length - placed.length;
		result.warnings.push(`${lost} attachment(s) belonged to items that couldn't be imported.`);
	}
	return placed.length > 0 ? { ...result, attachments: placed } : result;
}
