import { parseBitwarden } from "./bitwarden";
import { parseKeePass } from "./keepass";
import { parseOnePassword } from "./onepassword";
import { parseProtonPass } from "./protonpass";
import type { ImportParser, ImportProvider, ImportResult } from "./types";

export { kdbxEntriesToResult } from "./kdbx";
export type { ImportProvider, ImportResult } from "./types";
export { parseBitwarden, parseKeePass, parseOnePassword, parseProtonPass };

const PARSERS: Record<ImportProvider, ImportParser> = {
	bitwarden: parseBitwarden,
	onepassword: parseOnePassword,
	protonpass: parseProtonPass,
	keepass: parseKeePass,
};

export type ImportProviderId = ImportProvider | "keepass-kdbx";

export interface ImportProviderInfo {
	id: ImportProviderId;
	label: string;
	blurb: string;
	accept: string;
	reads: "text" | "bytes";
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
];

export function parseImport(provider: ImportProvider, raw: string | Uint8Array): ImportResult {
	return PARSERS[provider](raw);
}
