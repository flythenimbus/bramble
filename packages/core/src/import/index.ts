import { parseBitwarden } from "./bitwarden";
import { parseApplePasswords, parseGooglePasswords } from "./csv";
import { parseKeePass } from "./keepass";
import { parseOnePassword } from "./onepassword";
import { parseProtonPass } from "./protonpass";
import type { ImportParser, ImportParserContext, ImportProvider, ImportResult } from "./types";

export { kdbxEntriesToResult } from "./kdbx";
export { tallyByType } from "./shared";
export type { ImportParserContext, ImportProvider, ImportResult } from "./types";
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

/**
 * Provider id. `keepass-kdbx` has no synchronous parser (opened in WASM), and
 * `credential-exchange` has no file at all (the OS hands us the payload).
 */
type ImportProviderId = ImportProvider | "keepass-kdbx" | "bramble" | "credential-exchange";

/** UI-facing description of a supported import provider. Icons live in the UI layer. */
export interface ImportProviderInfo {
	id: ImportProviderId;
	label: string;
	blurb: string;
	/** Absent for providers that don't read a file. */
	accept?: string;
	reads?: "text" | "bytes";
	/** kdbx: prompt for credentials and open via CryptoAdapter.openKdbx, not parseImport. */
	needsCredential?: boolean;
	/** No file picker: the payload arrives from the OS. Gated on the `credentialExchange` capability. */
	viaSystem?: boolean;
}

export const IMPORT_PROVIDERS: readonly ImportProviderInfo[] = [
	{
		// First because it is the best route where it exists: passkeys come across too, and
		// nothing is written to disk. Hidden unless the platform supports it.
		id: "credential-exchange",
		label: "Another app on this device",
		blurb: "Passwords, passkeys and codes, with no file in between",
		viaSystem: true,
	},
	{
		// Bramble's own format, so it is the only file import that keeps passkeys and
		// password history. Sealed under the password chosen at export, not the master
		// password. Second because it is the best file route where the user has one.
		id: "bramble",
		label: "Bramble (.bramble)",
		blurb: "An export from another Bramble vault, passkeys included",
		accept: ".bramble",
		reads: "bytes",
		needsCredential: true,
	},
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
		// Matches the label the CSV parser names in its "wrong file" error, so the message
		// points at a card the user can actually see.
		label: "Google Password Manager",
		blurb: "passwords.google.com → Export (.csv)",
		accept: ".csv,text/csv",
		reads: "text",
	},
];

/** Parse a provider export into normalized entries. Read the file as the provider's `reads` kind. */
export function parseImport(
	provider: ImportProvider,
	raw: string | Uint8Array,
	context: ImportParserContext,
): ImportResult | Promise<ImportResult> {
	return PARSERS[provider](raw, context);
}
