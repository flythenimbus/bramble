import type { KdbxRawEntry } from "../adapters/crypto";
import { mapKeepassFields } from "./keepass";
import type { RawField } from "./shared";
import { summarize } from "./shared";
import type { ImportResult } from "./types";

/** Map decrypted KDBX entries (opened in WASM) to an ImportResult, reusing the XML field mapper. */
export function kdbxEntriesToResult(entries: KdbxRawEntry[]): ImportResult {
	const mapped = entries.map((entry) => {
		const fields: RawField[] = entry.strings.map((s) => ({
			key: s.key,
			value: s.value,
			hidden: s.protected,
		}));
		return mapKeepassFields(fields);
	});
	return summarize(mapped, 0, []);
}
