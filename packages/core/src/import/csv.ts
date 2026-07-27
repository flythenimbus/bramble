// Flat login CSVs: Apple Passwords and Google Password Manager. One module for both, because
// the formats differ only in their column names — everything else (the RFC 4180 read, the row
// mapping, the "you picked the wrong card" check) is shared. Adding Chrome/Firefox/Edge/Safari
// later is a new SPEC entry, not a new parser.
//
// Neither format carries folders, cards, notes-as-items, or passkeys, so every row becomes a
// login. Google carries no TOTP at all; Apple's OTPAuth column holds a full otpauth:// URI,
// which we pass through verbatim like the Bitwarden importer does.

import type { EntryData } from "../hooks/useVault";
import { asText, parseCsvRows, summarize } from "./shared";
import type { ImportResult } from "./types";

type Field = "name" | "url" | "username" | "password" | "notes" | "totp";

interface CsvSpec {
	label: string;
	/** Accepted header labels per field, lower-cased. The file's own header row decides order. */
	columns: Record<Field, readonly string[]>;
	/** Headers that must ALL be present to accept the file as this provider's export. */
	signature: readonly string[];
}

// Apple Passwords: `Title,URL,Username,Password,Notes,OTPAuth`. Apple documents none of this,
// but its own importer rejects any other header ("missing column labels"), so it's fixed.
const APPLE: CsvSpec = {
	label: "Apple Passwords",
	columns: {
		name: ["title"],
		url: ["url"],
		username: ["username"],
		password: ["password"],
		notes: ["notes"],
		totp: ["otpauth"],
	},
	signature: ["title", "url", "username", "password", "otpauth"],
};

// Google Password Manager: `name,url,username,password,note`, written by Chromium's
// password_csv_writer.cc. `note` arrived later than the rest, so it stays out of the
// signature and older four-column exports still import.
const GOOGLE: CsvSpec = {
	label: "Google Password Manager",
	columns: {
		name: ["name"],
		url: ["url"],
		username: ["username"],
		password: ["password"],
		notes: ["note", "notes"],
		totp: [],
	},
	signature: ["name", "url", "username", "password"],
};

// The signatures are mutually exclusive (Apple has title+otpauth and no `name`; Google has
// `name` and neither), so a mis-picked file is detectable rather than silently empty.
const OTHER = new Map<CsvSpec, CsvSpec>([
	[APPLE, GOOGLE],
	[GOOGLE, APPLE],
]);

/** Best-effort display name for a row with no title: the URL's host, else the raw URL. */
function hostLabel(url: string): string {
	if (!url) return "";
	try {
		return new URL(url).hostname || url;
	} catch {
		// Bare hosts ("example.com") have no scheme, so URL() throws; retry with one.
		try {
			return new URL(`https://${url}`).hostname || url;
		} catch {
			return url;
		}
	}
}

function parseSpec(spec: CsvSpec, raw: string | Uint8Array): ImportResult {
	const rows = parseCsvRows(asText(raw));
	const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
	if (!spec.signature.every((h) => header.includes(h))) {
		const other = OTHER.get(spec);
		// No indefinite article before the label: it would read "a Apple Passwords export".
		if (other?.signature.every((h) => header.includes(h))) {
			throw new Error(
				`This looks like an export from ${other.label}. Go back and choose ${other.label} instead.`,
			);
		}
		throw new Error(
			`This doesn't look like an export from ${spec.label}. Its first line should be the column names.`,
		);
	}

	const indexOf = (field: Field): number => {
		for (const alias of spec.columns[field]) {
			const i = header.indexOf(alias);
			if (i !== -1) return i;
		}
		return -1;
	};
	const at = (row: string[], i: number): string => (i === -1 ? "" : (row[i] ?? ""));
	const cols = {
		name: indexOf("name"),
		url: indexOf("url"),
		username: indexOf("username"),
		password: indexOf("password"),
		notes: indexOf("notes"),
		totp: indexOf("totp"),
	};

	const imported: EntryData[] = [];
	let skipped = 0;

	for (const row of rows.slice(1)) {
		const url = at(row, cols.url);
		const username = at(row, cols.username);
		const password = at(row, cols.password);
		const notes = at(row, cols.notes);
		const totp = at(row, cols.totp);
		// A row with nothing identifying and no secret carries no entry (trailing junk lines,
		// or a row whose every cell is blank).
		if (!url && !username && !password && !notes && !totp) {
			skipped++;
			continue;
		}
		imported.push({
			type: "login",
			name: at(row, cols.name) || hostLabel(url) || username,
			notes: notes || undefined,
			urls: url ? [url] : [],
			username,
			password,
			totp: totp || undefined,
		});
	}

	return summarize(imported, skipped, []);
}

/** Parse an Apple Passwords CSV export (`Title,URL,Username,Password,Notes,OTPAuth`). */
export function parseApplePasswords(raw: string | Uint8Array): ImportResult {
	return parseSpec(APPLE, raw);
}

/** Parse a Google Password Manager CSV export (`name,url,username,password,note`). */
export function parseGooglePasswords(raw: string | Uint8Array): ImportResult {
	return parseSpec(GOOGLE, raw);
}
