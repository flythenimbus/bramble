import type { PasskeyImportResult } from "../adapters/crypto";
import type { EntryData, EntryType } from "../hooks/useVault";

/** Password managers whose plaintext/container exports Bramble can read. */
export type ImportProvider =
	| "bitwarden"
	| "onepassword"
	| "protonpass"
	| "keepass"
	| "apple"
	| "google"
	| "lastpass";

/** Normalized parse result. `imported` is id-less (the vault assigns ids); `warnings` flags lossy mappings. */
export interface ImportResult {
	imported: EntryData[];
	byType: Partial<Record<EntryType, number>>;
	skipped: number;
	warnings: string[];
}

/** Narrow async services available to importers; ordinary parsers ignore this context. */
export interface ImportParserContext {
	passkeyImportPkcs8(pkcs8StandardB64: string): Promise<PasskeyImportResult>;
}

/** String for text formats, bytes for containers. Crypto-backed parsers may be asynchronous. */
export type ImportParser = (
	raw: string | Uint8Array,
	context: ImportParserContext,
) => ImportResult | Promise<ImportResult>;
