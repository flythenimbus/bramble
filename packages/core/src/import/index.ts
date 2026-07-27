import { parseBitwarden } from "./bitwarden";
import { parseApplePasswords, parseGooglePasswords } from "./csv";
import { parseKeePass } from "./keepass";
import { parseOnePassword } from "./onepassword";
import { parseProtonPass } from "./protonpass";
import type { ImportParser, ImportProvider, ImportResult } from "./types";

export { kdbxEntriesToResult } from "./kdbx";
export type { ImportProvider, ImportResult } from "./types";
export {
	parseApplePasswords,
	parseBitwarden,
	parseGooglePasswords,
	parseKeePass,
	parseOnePassword,
	parseProtonPass,
};

const PARSERS: Record<ImportProvider, ImportParser> = {
	bitwarden: parseBitwarden,
	onepassword: parseOnePassword,
	protonpass: parseProtonPass,
	keepass: parseKeePass,
	apple: parseApplePasswords,
	google: parseGooglePasswords,
};

/** Provider id, including `keepass-kdbx` which has no synchronous parser (opened in WASM). */
export type ImportProviderId = ImportProvider | "keepass-kdbx";

/** UI-facing description of a supported import provider. Icons live in the UI layer. */
export interface ImportProviderInfo {
	id: ImportProviderId;
	label: string;
	blurb: string;
	accept: string;
	reads: "text" | "bytes";
	/** kdbx: prompt for credentials and open via CryptoAdapter.openKdbx, not parseImport. */
	needsCredential?: boolean;
}

export const IMPORT_PROVIDERS: readonly ImportProviderInfo[] = [
	{
		id: "bitwarden",
		label: "Bitwarden",
		blurb: "Unencrypted .json export",
		accept: ".json,application/json",
		reads: "text",
	},
	{
		id: "onepassword",
		label: "1Password",
		blurb: ".1pux export",
		accept: ".1pux,.zip",
		reads: "bytes",
	},
	{
		id: "protonpass",
		label: "Proton Pass",
		blurb: "Unencrypted .zip export",
		accept: ".zip",
		reads: "bytes",
	},
	{
		id: "keepass",
		label: "KeePass (XML)",
		blurb: "File → Export → KeePass 2.x XML",
		accept: ".xml,text/xml,application/xml",
		reads: "text",
	},
	{
		id: "keepass-kdbx",
		label: "KeePass (.kdbx)",
		blurb: "Encrypted .kdbx database (KDBX4)",
		accept: ".kdbx",
		reads: "bytes",
		needsCredential: true,
	},
	{
		id: "apple",
		label: "Apple Passwords",
		blurb: "Passwords → Export All Passwords (.csv)",
		accept: ".csv,text/csv",
		reads: "text",
	},
	{
		id: "google",
		label: "Google Passwords",
		blurb: "passwords.google.com → Export (.csv)",
		accept: ".csv,text/csv",
		reads: "text",
	},
];

/** Parse a provider export into normalized entries. Read the file as the provider's `reads` kind. */
export function parseImport(provider: ImportProvider, raw: string | Uint8Array): ImportResult {
	return PARSERS[provider](raw);
}
