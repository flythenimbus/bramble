import type { PasskeyImportResult } from "../adapters/crypto";
import type { EntryData, EntryType } from "../hooks/useVault";
import type { FileSource } from "../vault/file-mutations";

/** Password managers whose plaintext/container exports Bramble can read. */
export type ImportProvider =
	| "bitwarden"
	| "onepassword"
	| "protonpass"
	| "keepass"
	| "apple"
	| "google"
	| "lastpass"
	| "enpass"
	| "aliasvault";

/** Normalized parse result. `imported` is id-less (the vault assigns ids); `warnings` flags lossy mappings. */
export interface ImportResult {
	imported: EntryData[];
	byType: Partial<Record<EntryType, number>>;
	skipped: number;
	warnings: string[];
	/** Files the import brings (only KeePass carries any), each on one of `imported`. */
	attachments?: ImportAttachment[];
}

/** A file an import brings, on one of its entries (that entry object, from `imported`). */
export interface ImportAttachment {
	entry: EntryData;
	name: string;
	mime: string;
	source: FileSource;
	size: number;
}

/** An import's file, placed: on one of the items being imported, or, for an item the vault
 * already holds, on that entry, so re-importing a file brings the attachments a copy lacks. */
export interface PlacedAttachment extends Omit<ImportAttachment, "entry"> {
	onto: { item: EntryData } | { entryId: string };
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
