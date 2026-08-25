// Flat login CSVs: Apple Passwords and Google Password Manager. One module for both, because
// the formats differ only in their column names — everything else (the RFC 4180 read, the row
// mapping, the "you picked the wrong card" check) is shared. Adding Chrome/Firefox/Edge/Safari
// later is a new SPEC entry, not a new parser.
//
// Neither format carries folders, cards, notes-as-items, or passkeys, so every row becomes a
// login. Google carries no TOTP at all; Apple's OTPAuth column holds a full otpauth:// URI,
// which we pass through verbatim like the Bitwarden importer does.

import type { EntryData } from "../hooks/useVault";
import { APPLE_CSV, assertFormat, type CsvFormat, GOOGLE_CSV, headerLabels } from "./csv-format";
import { asText, hostLabel, parseCsvRows, summarize } from "./shared";
import type { ImportResult } from "./types";

type Field = "name" | "url" | "username" | "password" | "notes" | "totp";

interface CsvSpec {
	/** How the header row is recognised, and what to call the format in an error. */
	format: CsvFormat;
	/** Accepted header labels per field, lower-cased. The file's own header row decides order. */
	columns: Record<Field, readonly string[]>;
}

const APPLE: CsvSpec = {
	format: APPLE_CSV,
	columns: {
		name: ["title"],
		url: ["url"],
		username: ["username"],
		password: ["password"],
		notes: ["notes"],
		totp: ["otpauth"],
	},
};

const GOOGLE: CsvSpec = {
	format: GOOGLE_CSV,
	columns: {
		name: ["name"],
		url: ["url"],
		username: ["username"],
		password: ["password"],
		notes: ["note", "notes"],
		totp: [],
	},
};

function parseSpec(spec: CsvSpec, raw: string | Uint8Array): ImportResult {
	const rows = parseCsvRows(asText(raw));
	const header = headerLabels(rows[0]);
	assertFormat(spec.format, header);

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
