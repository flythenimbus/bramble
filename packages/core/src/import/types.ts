import type { EntryData, EntryType } from "../hooks/useVault";

export type ImportProvider = "bitwarden" | "onepassword" | "protonpass" | "keepass";

export interface ImportResult {
	imported: EntryData[];
	byType: Partial<Record<EntryType, number>>;
	skipped: number;
	warnings: string[];
}

export type ImportParser = (raw: string | Uint8Array) => ImportResult;
