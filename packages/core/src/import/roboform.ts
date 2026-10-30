// RoboForm CSV export: `Name,Url,MatchUrl,Login,Pwd,Note,Folder,RfFieldsV2`. Only logins,
// bookmarks and safenotes reach the file; identities (which hold credit cards) export only as a
// printout, so the provider card says so. docs/roboform-import.md records the format.

import type { EntryData } from "../hooks/useVault";
import { normalizeTags } from "../vault/tags";
import { assertFormat, headerLabels, ROBOFORM_CSV } from "./csv-format";
import {
	asText,
	hostLabel,
	parseCsvRows,
	type RawField,
	summarize,
	toCustomFields,
} from "./shared";
import type { ImportResult } from "./types";

// One RfFieldsV2 cell: `<name>,<?>,<?>,<txt|pwd>,<value>`. The value runs to the end of the cell.
const FIELD = /^([^,]*),[^,]*,[^,]*,([^,]*),([\s\S]*)$/;

/** RoboForm prepends `'` to a value starting with `=`, `+`, `-`, `@` or `'`; drop exactly that one. */
function unquote(value: string): string {
	return value.replace(/^'(?=[=+\-@'])/, "");
}

/** The login's TOTP key and every other field, minus the ones repeating the login's columns. */
function readFields(
	cells: readonly string[],
	username: string,
	password: string,
): { totp?: string; extras: RawField[] } {
	let totp: string | undefined;
	const extras: RawField[] = [];
	for (const cell of cells) {
		const m = FIELD.exec(cell);
		if (!m) {
			extras.push({ key: "Field", value: cell });
			continue;
		}
		const [, key = "", type = "", raw = ""] = m;
		const value = unquote(raw);
		if (key === "TOTP KEY$" && !totp) totp = value;
		else if (key === "User ID$") {
			if (value !== username) extras.push({ key: "Username", value });
		} else if (key === "Password$") {
			if (value !== password) extras.push({ key: "Password", value, hidden: true });
		} else {
			const label = key && key !== "-no-name-" ? key : "Field";
			extras.push({ key: label, value, hidden: type === "pwd" || undefined });
		}
	}
	return { totp, extras };
}

/** Parse a RoboForm CSV export (`Name,Url,MatchUrl,Login,Pwd,Note,Folder,RfFieldsV2`). */
export function parseRoboForm(raw: string | Uint8Array): ImportResult {
	const rows = parseCsvRows(asText(raw));
	const header = headerLabels(rows[0]);
	assertFormat(ROBOFORM_CSV, header);

	const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
	const cols = {
		name: col("name"),
		url: col("url"),
		matchUrl: col("matchurl"),
		login: col("login"),
		password: col("pwd", "password"),
		note: col("note"),
		folder: col("folder"),
		// `Rf_fields` is the older name; its cells don't match FIELD, so they're kept verbatim.
		fields: col("rffieldsv2", "rf_fields"),
	};
	const at = (row: string[], i: number): string => (i === -1 ? "" : (row[i] ?? ""));

	const imported: EntryData[] = [];
	let skipped = 0;
	let foldered = 0;

	for (const row of rows.slice(1)) {
		const name = at(row, cols.name).trim();
		const url = at(row, cols.url);
		const matchUrl = at(row, cols.matchUrl);
		const username = unquote(at(row, cols.login));
		const password = unquote(at(row, cols.password));
		const notes = at(row, cols.note) || undefined;
		// The fields column spills over: every cell from it to the end of the row is one field.
		const cells = cols.fields === -1 ? [] : row.slice(cols.fields).filter(Boolean);
		// Folders are written `/Work/Clients`. One tag per level, as LastPass.
		const tags = normalizeTags(at(row, cols.folder).split("/"));

		let entry: EntryData;
		if (matchUrl || username || password || cells.length > 0) {
			const { totp, extras } = readFields(cells, username, password);
			const urls = [...new Set([url, matchUrl].filter(Boolean))];
			entry = {
				type: "login",
				name: name || hostLabel(urls[0] ?? "") || username,
				notes,
				urls,
				username,
				password,
				// A bare base32 secret; parseTotp accepts it.
				totp,
				customFields: toCustomFields(extras),
				tags,
			};
		} else if (url) {
			// A bookmark: kept as a note so an empty login never offers itself for autofill.
			entry = {
				type: "note",
				name: name || hostLabel(url),
				notes,
				customFields: toCustomFields([{ key: "URL", value: url }]),
				tags,
			};
		} else if (name || notes) {
			entry = { type: "note", name, notes, tags };
		} else {
			skipped++;
			continue;
		}
		if (tags) foldered++;
		imported.push(entry);
	}

	const warnings: string[] = [];
	if (foldered > 0) {
		warnings.push(`${foldered} item(s) were in a RoboForm folder, imported as tags.`);
	}
	return summarize(imported, skipped, warnings);
}
