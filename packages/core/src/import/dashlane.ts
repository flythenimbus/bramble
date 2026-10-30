// Dashlane CSV export: a zip of up to five CSVs, each known by its header rather than its file
// name. A lone CSV is read too, since Safari unzips downloads. The encrypted .dash export isn't
// read. docs/dashlane-import.md records the format.

import { strFromU8 } from "fflate";
import type { EntryData } from "../hooks/useVault";
import { cardBrand } from "../util/card";
import { normalizeTags } from "../vault/tags";
import { assertFormat, DASHLANE_CSV, headerLabels } from "./csv-format";
import {
	asText,
	hostLabel,
	parseCsvRows,
	type RawField,
	summarize,
	toCustomFields,
	unzipCapped,
} from "./shared";
import type { ImportResult } from "./types";

type Kind = "credentials" | "securenotes" | "payments" | "ids" | "personalInfo";

// Tried in this order: a credentials header also holds `title` and `note`, which is all a
// secure notes header has.
const SIGNATURES: readonly [Kind, readonly string[]][] = [
	["credentials", DASHLANE_CSV.signature],
	["payments", ["type", "account_name", "cc_number"]],
	["ids", ["type", "number", "issue_date"]],
	["personalInfo", ["type", "first_name", "item_name"]],
	["securenotes", ["title", "note"]],
];
/** The order entries are imported in. */
const ORDER: readonly Kind[] = ["credentials", "securenotes", "payments", "ids", "personalInfo"];

// Labels for the columns kept as fields; a column not listed keeps its own name.
const LABELS: Record<string, string> = {
	username2: "Username 2",
	username3: "Username 3",
	account_holder: "Account holder",
	routing_number: "Routing number",
	account_number: "Account number",
	country: "Country",
	issuing_bank: "Bank",
	number: "Number",
	name: "Name",
	issue_date: "Issued",
	expiration_date: "Expires",
	place_of_issue: "Place of issue",
	state: "State",
	title: "Title",
	first_name: "First name",
	middle_name: "Middle name",
	last_name: "Last name",
	login: "Username",
	date_of_birth: "Date of birth",
	place_of_birth: "Place of birth",
	email: "Email",
	email_type: "Email type",
	item_name: "Item name",
	phone_number: "Phone",
	address: "Address",
	city: "City",
	zip: "Postcode",
	address_recipient: "Recipient",
	address_building: "Building",
	address_apartment: "Apartment",
	address_floor: "Floor",
	address_door_code: "Door code",
	job_title: "Job title",
	url: "Website",
};
const DATES = new Set(["issue_date", "expiration_date", "date_of_birth"]);

const CARD_TYPES = new Set(["payment_card", "credit_card"]);
const ID_NAMES: Record<string, string> = {
	card: "ID card",
	passport: "Passport",
	license: "Driver's license",
	social_security: "Social security number",
	tax_number: "Tax number",
};
// A personal info row's name when it has no `item_name`, as a real email row doesn't.
const PERSONAL_NAMES: Record<string, string> = {
	email: "Email",
	number: "Phone",
	address: "Address",
	website: "Website",
	company: "Company",
};

const FORMAT_ERROR = "This doesn't look like a Dashlane export.";
const CORRUPT_ERROR = "Couldn't read this Dashlane file. It may be corrupt.";
const LONE_CSV =
	"This is one file of a Dashlane export. Import its other CSV files the same way, or choose the .zip.";

interface Sheet {
	kind: Kind;
	/** Lower-cased, for lookups. */
	header: string[];
	/** As written, for the names of fields we have no label for. */
	labels: string[];
	rows: string[][];
}

interface Row {
	get(column: string): string;
	/** Every column not in `used`, as fields. Blank ones are dropped by toCustomFields. */
	rest(used: readonly string[]): RawField[];
}

function readSheet(text: string): Omit<Sheet, "kind"> & { kind?: Kind } {
	const rows = parseCsvRows(text);
	const header = headerLabels(rows[0]);
	const kind = SIGNATURES.find(([, sig]) => sig.every((h) => header.includes(h)))?.[0];
	return { kind, header, labels: (rows[0] ?? []).map((l) => l.trim()), rows: rows.slice(1) };
}

/** Dashlane drops the leading zero from a month or day (`2022-1-30`). */
function padDate(value: string): string {
	const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim());
	if (!m) return value;
	const [, y = "", mo = "", d = ""] = m;
	return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function rowOf(sheet: Sheet, row: string[]): Row {
	const at = (i: number) => (i === -1 ? "" : (row[i] ?? ""));
	return {
		get: (column) => at(sheet.header.indexOf(column)),
		rest: (used) =>
			sheet.header.flatMap((column, i) => {
				if (used.includes(column)) return [];
				const value = DATES.has(column) ? padDate(at(i)) : at(i);
				return [{ key: LABELS[column] ?? sheet.labels[i] ?? column, value }];
			}),
	};
}

function toEntry(kind: Kind, r: Row, tags: string[] | undefined): EntryData {
	const notes = r.get("note") || undefined;
	switch (kind) {
		case "credentials": {
			const url = r.get("url");
			const username = r.get("username");
			const used = [
				"username",
				"title",
				"password",
				"note",
				"url",
				"category",
				"otpurl",
				"otpsecret",
			];
			return {
				type: "login",
				name: r.get("title").trim() || hostLabel(url) || username,
				notes,
				urls: url ? [url] : [],
				username,
				password: r.get("password"),
				// `otpUrl` holds an otpauth:// URI, the older `otpSecret` a bare secret; parseTotp takes both.
				totp: r.get("otpurl") || r.get("otpsecret") || undefined,
				customFields: toCustomFields(r.rest(used)),
				tags,
			};
		}
		case "securenotes":
			return {
				type: "note",
				name: r.get("title").trim(),
				notes,
				customFields: toCustomFields(r.rest(["title", "note", "category"])),
				tags,
			};
		case "payments": {
			const name = r.get("name").trim() || r.get("account_name").trim();
			const used = ["type", "account_name", "name", "note", "category"];
			if (!CARD_TYPES.has(r.get("type"))) {
				// A bank account, or a kind this doesn't know: the vault has no type for either.
				return { type: "note", name, notes, customFields: toCustomFields(r.rest(used)), tags };
			}
			const number = r.get("cc_number");
			const month = r.get("expiration_month").trim();
			const cardColumns = ["cc_number", "code", "expiration_month", "expiration_year"];
			return {
				type: "card",
				name,
				notes,
				cardholderName: r.get("account_name"),
				number,
				brand: cardBrand(number),
				// "03" and "3" are the same month; the vault stores it without the zero.
				expMonth: month && Number.isInteger(Number(month)) ? String(Number(month)) : month,
				expYear: r.get("expiration_year").trim(),
				cvv: r.get("code"),
				customFields: toCustomFields(r.rest([...used, ...cardColumns])),
				tags,
			};
		}
		case "ids": {
			const type = r.get("type");
			const what = ID_NAMES[type] ?? type;
			const holder = r.get("name").trim();
			return {
				type: "note",
				name: holder ? `${what} (${holder})` : what,
				notes,
				customFields: toCustomFields(r.rest(["type", "note", "category"])),
				tags,
			};
		}
		case "personalInfo": {
			// One row per detail (a name, an email, an address), each its own note.
			const type = r.get("type");
			const person = ["first_name", "middle_name", "last_name"].map((c) => r.get(c).trim());
			const name =
				type === "name"
					? person.filter(Boolean).join(" ")
					: r.get("item_name").trim() || PERSONAL_NAMES[type] || type;
			const used =
				type === "name" ? ["type", "note", "category"] : ["type", "item_name", "note", "category"];
			return { type: "note", name, notes, customFields: toCustomFields(r.rest(used)), tags };
		}
	}
}

function fromSheets(sheets: readonly Sheet[], warnings: string[]): ImportResult {
	const imported: EntryData[] = [];
	let skipped = 0;
	let categorised = 0;
	for (const kind of ORDER) {
		for (const sheet of sheets.filter((s) => s.kind === kind)) {
			for (const row of sheet.rows) {
				if (row.every((c) => !c.trim())) {
					skipped++;
					continue;
				}
				const r = rowOf(sheet, row);
				// An item in several collections lists them comma-separated: one tag each.
				const tags = normalizeTags(r.get("category").split(","));
				if (tags) categorised++;
				imported.push(toEntry(kind, r, tags));
			}
		}
	}
	if (categorised > 0) {
		warnings.push(`${categorised} item(s) had a Dashlane category, imported as tags.`);
	}
	return summarize(imported, skipped, warnings);
}

function isZip(raw: string | Uint8Array): raw is Uint8Array {
	return typeof raw !== "string" && raw[0] === 0x50 && raw[1] === 0x4b;
}

/** Parse a Dashlane CSV export: the .zip, or any one CSV from it. */
export function parseDashlane(raw: string | Uint8Array): ImportResult {
	const warnings: string[] = [];

	if (!isZip(raw)) {
		const sheet = readSheet(asText(raw));
		if (!sheet.kind) {
			assertFormat(DASHLANE_CSV, sheet.header);
			throw new Error(FORMAT_ERROR);
		}
		warnings.push(LONE_CSV);
		return fromSheets([{ ...sheet, kind: sheet.kind }], warnings);
	}

	const sheets: Sheet[] = [];
	for (const [path, data] of Object.entries(unzipCapped(raw, CORRUPT_ERROR))) {
		const base = path.split("/").pop() ?? "";
		// Directory entries, and the metadata a zip made by Finder carries.
		if (!base || base.startsWith(".") || path.startsWith("__MACOSX/")) continue;
		const sheet = readSheet(strFromU8(data));
		if (sheet.kind) sheets.push({ ...sheet, kind: sheet.kind });
		else warnings.push(`${base} isn't a Dashlane file Bramble knows, so it wasn't imported.`);
	}
	if (sheets.length === 0) throw new Error(FORMAT_ERROR);
	return fromSheets(sheets, warnings);
}
