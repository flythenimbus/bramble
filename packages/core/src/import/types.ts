import type { EntryData, EntryType } from "../hooks/useVault";

/** Password managers we can read a (synchronous) export from. */
export type ImportProvider =
	| "bitwarden"
	| "onepassword"
	| "protonpass"
	| "keepass"
	| "apple"
	| "google";

/** Normalized parse result. `imported` is id-less (the vault assigns ids); `warnings` flags lossy mappings. */
export interface ImportResult {
	imported: EntryData[];
	byType: Partial<Record<EntryType, number>>;
	skipped: number;
	warnings: string[];
}

/** Pure parser: string for text formats (JSON/XML), bytes for containers (.1pux/.zip). */
export type ImportParser = (raw: string | Uint8Array) => ImportResult;
