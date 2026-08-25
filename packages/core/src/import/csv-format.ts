// Which flat-CSV export a file actually is, decided from its header row alone. Shared by the
// Apple/Google reader and the LastPass one, so a mis-picked file can be named instead of
// silently half-imported. See docs/lastpass-import.md.

/** A CSV export identified by its header row. */
export interface CsvFormat {
	label: string;
	/** Headers that must ALL be present to accept the file as this format. */
	signature: readonly string[];
	/** Headers that must NOT be present, where another format's header is a superset of this one's. */
	reject?: readonly string[];
}

// Apple Passwords: `Title,URL,Username,Password,Notes,OTPAuth`. Apple documents none of this,
// but its own importer rejects any other header ("missing column labels"), so it's fixed.
export const APPLE_CSV: CsvFormat = {
	label: "Apple Passwords",
	signature: ["title", "url", "username", "password", "otpauth"],
};

// Google Password Manager: `name,url,username,password,note`, written by Chromium's
// password_csv_writer.cc. `note` arrived later than the rest, so it stays out of the signature
// and older four-column exports still import. That leaves the signature a subset of every
// LastPass header, hence `reject`: without it a LastPass file passes as a Google one, and its
// secure notes arrive as junk logins with the TOTP and folder columns dropped in silence.
export const GOOGLE_CSV: CsvFormat = {
	label: "Google Password Manager",
	signature: ["name", "url", "username", "password"],
	reject: ["extra", "grouping"],
};

// LastPass: `url,username,password,totp,extra,name,grouping,fav`. `totp` was inserted in the
// middle in 2022, so it stays out of the signature and older exports still import.
export const LASTPASS_CSV: CsvFormat = {
	label: "LastPass",
	signature: ["url", "username", "password", "extra", "name", "grouping"],
};

const ALL: readonly CsvFormat[] = [APPLE_CSV, GOOGLE_CSV, LASTPASS_CSV];

/** A header row reduced to lower-cased, trimmed labels. */
export function headerLabels(row: readonly string[] | undefined): string[] {
	return (row ?? []).map((h) => h.trim().toLowerCase());
}

/** Whether a header row identifies this format. */
export function matchesFormat(format: CsvFormat, header: readonly string[]): boolean {
	if (!format.signature.every((h) => header.includes(h))) return false;
	return !format.reject?.some((h) => header.includes(h));
}

/** Accept the header as `format`, or throw naming the format it really is where we recognise one. */
export function assertFormat(format: CsvFormat, header: readonly string[]): void {
	if (matchesFormat(format, header)) return;
	const actual = ALL.find((f) => f !== format && matchesFormat(f, header));
	// No indefinite article before the label: it would read "a Apple Passwords export".
	if (actual) {
		throw new Error(
			`This looks like an export from ${actual.label}. Go back and choose ${actual.label} instead.`,
		);
	}
	throw new Error(
		`This doesn't look like an export from ${format.label}. Its first line should be the column names.`,
	);
}
