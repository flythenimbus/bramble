// LastPass CSV export. Two header variants, and secure notes (url `http://sn`) whose `extra`
// column carries a typed `Key:Value` block. Values may contain commas, colons and newlines, and
// `Notes:` runs to the end of the block, so it is read against the template for its NoteType
// rather than line by line. docs/lastpass-import.md records the format and the evidence for it.

import type { EntryData } from "../hooks/useVault";
import { cardBrand } from "../util/card";
import { deriveKeyType } from "../util/ssh";
import { assertFormat, headerLabels, LASTPASS_CSV } from "./csv-format";
import {
	asText,
	hostLabel,
	parseCsvRows,
	type RawField,
	summarize,
	toCustomFields,
} from "./shared";
import type { ImportResult } from "./types";

/** The URL LastPass writes on a secure note. */
const SECURE_NOTE_URL = "http://sn";
/** ...and the one it writes when an entry has no URL at all. */
const NO_URL = "http://";

// Field order per NoteType, from lastpass-cli's notes.c. The order is what lets a value holding
// a newline (an SSH private key) be told apart from the next field, so it is load-bearing.
// `Address` is absent from notes.c but is emitted by the browser extension.
const TEMPLATES: Record<string, readonly string[]> = {
	"Bank Account": [
		"Bank Name",
		"Account Type",
		"Routing Number",
		"Account Number",
		"SWIFT Code",
		"IBAN Number",
		"Pin",
		"Branch Address",
		"Branch Phone",
	],
	"Credit Card": [
		"Name on Card",
		"Type",
		"Number",
		"Security Code",
		"Start Date",
		"Expiration Date",
	],
	Database: ["Type", "Hostname", "Port", "Database", "Username", "Password", "SID", "Alias"],
	"Driver's License": [
		"Number",
		"Expiration Date",
		"License Class",
		"Name",
		"Address",
		"City / Town",
		"State",
		"ZIP / Postal Code",
		"Country",
		"Date of Birth",
		"Sex",
		"Height",
	],
	"Email Account": ["Username", "Password", "Server", "Port", "Type", "SMTP Server", "SMTP Port"],
	"Health Insurance": [
		"Company",
		"Company Phone",
		"Policy Type",
		"Policy Number",
		"Group ID",
		"Member Name",
		"Member ID",
		"Physician Name",
		"Physician Phone",
		"Physician Address",
		"Co-pay",
	],
	"Instant Messenger": ["Type", "Username", "Password", "Server", "Port"],
	Insurance: [
		"Company",
		"Policy Type",
		"Policy Number",
		"Expiration",
		"Agent Name",
		"Agent Phone",
		"URL",
	],
	Membership: [
		"Organization",
		"Membership Number",
		"Member Name",
		"Start Date",
		"Expiration Date",
		"Website",
		"Telephone",
		"Password",
	],
	Passport: [
		"Type",
		"Name",
		"Country",
		"Number",
		"Sex",
		"Nationality",
		"Date of Birth",
		"Issued Date",
		"Expiration Date",
	],
	Server: ["Hostname", "Username", "Password"],
	"Software License": [
		"License Key",
		"Licensee",
		"Version",
		"Publisher",
		"Support Email",
		"Website",
		"Price",
		"Purchase Date",
		"Order Number",
		"Number of Licenses",
		"Order Total",
	],
	"SSH Key": [
		"Bit Strength",
		"Format",
		"Passphrase",
		"Private Key",
		"Public Key",
		"Hostname",
		"Date",
	],
	"Social Security": ["Name", "Number"],
	"Wi-Fi Password": [
		"SSID",
		"Password",
		"Connection Type",
		"Connection Mode",
		"Authentication",
		"Encryption",
		"Use 802.1X",
		"FIPS Mode",
		"Key Type",
		"Protected",
		"Key Index",
	],
	Address: [
		"Title",
		"First Name",
		"Middle Name",
		"Last Name",
		"Username",
		"Gender",
		"Birthday",
		"Company",
		"Address 1",
		"Address 2",
		"Address 3",
		"City / Town",
		"County",
		"State",
		"Zip / Postal Code",
		"Country",
		"Timezone",
		"Email Address",
		"Phone",
		"Evening Phone",
		"Mobile Phone",
		"Fax",
	],
};

/** Template fields holding a secret, so they arrive masked rather than in plain sight. */
const SECRET_FIELDS = new Set(["password", "pin", "passphrase", "private key"]);

// Month names are always English, even in a pl-PL export, so one table covers every locale.
const MONTHS = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];

/** A parsed typed secure note. `Language` is dropped: it is emitted always and carries no user data. */
interface NoteBlock {
	noteType: string;
	fields: Map<string, string>;
	notes: string;
}

/**
 * Read a typed `Key:Value` block, or null when `extra` is an ordinary note body.
 *
 * Known types are read against their template, so a value spanning several lines (an SSH private
 * key, whose PEM headers contain colons of their own) is not mistaken for the next field. A
 * user-defined `Custom_<id>` type has no template, so there any `Key:` opens a field.
 */
function parseNoteBlock(extra: string): NoteBlock | null {
	if (!extra.startsWith("NoteType:")) return null;
	const lines = extra.split("\n");
	const noteType = (lines[0] ?? "").slice("NoteType:".length).trim();
	const template = TEMPLATES[noteType];
	const expected = ["Language", ...(template ?? []), "Notes"];

	const fields = new Map<string, string>();
	let key = "";
	let value: string[] = [];
	let next = 0;
	const flush = () => {
		if (key) fields.set(key, value.join("\n"));
	};

	for (const line of lines.slice(1)) {
		// `Notes:` is always last and runs to the end, so nothing after it opens a field.
		if (key !== "Notes") {
			const at = expected.findIndex((k, i) => i >= next && line.startsWith(`${k}:`));
			if (at !== -1) {
				flush();
				key = expected[at] as string;
				value = [line.slice(key.length + 1)];
				next = at + 1;
				continue;
			}
			const generic = template ? null : /^([^:\n]+):/.exec(line);
			if (generic?.[1]) {
				flush();
				key = generic[1];
				value = [line.slice(key.length + 1)];
				continue;
			}
		}
		value.push(line);
	}
	flush();

	const notes = fields.get("Notes") ?? "";
	fields.delete("Notes");
	fields.delete("Language");
	return { noteType, fields, notes };
}

/** LastPass writes an unset date as bare commas, which is not worth keeping as a field. */
function blankish(value: string): boolean {
	return value.replace(/[,\s]/g, "") === "";
}

/**
 * `<Month>,<Year>`, where the month is the English name and the year may be YY or YYYY.
 * `CardExpYearSchema` accepts both widths, so a two-digit year needs no normalizing; the month
 * does, because `CardExpMonthSchema` wants digits.
 */
function splitExpiry(value: string): { expMonth: string; expYear: string } {
	const parts = value.split(",").map((p) => p.trim());
	const month = MONTHS.indexOf((parts[0] ?? "").toLowerCase());
	const year = parts.slice(1).find((p) => /^(\d{2}|\d{4})$/.test(p));
	return { expMonth: month === -1 ? "" : String(month + 1), expYear: year ?? "" };
}

const BRANDS = new Map([
	["visa", "Visa"],
	["mastercard", "Mastercard"],
	["master card", "Mastercard"],
	["amex", "Amex"],
	["american express", "Amex"],
	["discover", "Discover"],
]);

/** A card's `Type` is free text (a real export carries `CC`), so the number decides where it can. */
function brandOf(number: string, type: string): string | undefined {
	return cardBrand(number) ?? BRANDS.get(type.trim().toLowerCase());
}

/** Template fields the entry type has no home for, kept so nothing is silently lost. */
function leftovers(fields: Map<string, string>, used: readonly string[]): RawField[] {
	const skip = new Set(used);
	const out: RawField[] = [];
	for (const [key, value] of fields) {
		if (skip.has(key) || blankish(value)) continue;
		out.push({ key, value, hidden: SECRET_FIELDS.has(key.toLowerCase()) || undefined });
	}
	return out;
}

const CARD_FIELDS = ["Name on Card", "Number", "Security Code", "Expiration Date"];
const SSH_FIELDS = ["Public Key", "Private Key", "Passphrase"];

/** Map a typed secure note onto the closest vault type, falling back to a note with custom fields. */
function fromNoteBlock(block: NoteBlock, name: string, folder: RawField[]): EntryData {
	const f = block.fields;
	const notes = block.notes || undefined;

	if (block.noteType === "Credit Card") {
		const number = f.get("Number") ?? "";
		const type = f.get("Type") ?? "";
		const brand = brandOf(number, type);
		// A `Type` that named no brand would otherwise be dropped on the floor.
		const used =
			brand && BRANDS.has(type.trim().toLowerCase()) ? [...CARD_FIELDS, "Type"] : CARD_FIELDS;
		return {
			type: "card",
			name,
			notes,
			cardholderName: f.get("Name on Card") ?? "",
			number,
			brand,
			...splitExpiry(f.get("Expiration Date") ?? ""),
			cvv: f.get("Security Code") ?? "",
			customFields: toCustomFields([...leftovers(f, used), ...folder]),
		};
	}

	const publicKey = f.get("Public Key") ?? "";
	const privateKey = f.get("Private Key") ?? "";
	if (block.noteType === "SSH Key" && (publicKey || privateKey)) {
		return {
			type: "ssh-key",
			name,
			notes,
			publicKey,
			privateKey,
			passphrase: f.get("Passphrase") || undefined,
			keyType: deriveKeyType(publicKey, privateKey),
			customFields: toCustomFields([...leftovers(f, SSH_FIELDS), ...folder]),
		};
	}

	return {
		type: "note",
		name,
		notes,
		customFields: toCustomFields([...leftovers(f, []), ...folder]),
	};
}

/** Parse a LastPass CSV export (`url,username,password,[totp,]extra,name,grouping,fav`). */
export function parseLastPass(raw: string | Uint8Array): ImportResult {
	const rows = parseCsvRows(asText(raw));
	const header = headerLabels(rows[0]);
	assertFormat(LASTPASS_CSV, header);

	const cols = {
		url: header.indexOf("url"),
		username: header.indexOf("username"),
		password: header.indexOf("password"),
		totp: header.indexOf("totp"),
		extra: header.indexOf("extra"),
		name: header.indexOf("name"),
		grouping: header.indexOf("grouping"),
	};
	const at = (row: string[], i: number): string => (i === -1 ? "" : (row[i] ?? ""));

	const imported: EntryData[] = [];
	const warnings: string[] = [];
	let skipped = 0;
	let foldered = 0;

	for (const row of rows.slice(1)) {
		const url = at(row, cols.url);
		const username = at(row, cols.username);
		const password = at(row, cols.password);
		const totp = at(row, cols.totp);
		const extra = at(row, cols.extra);
		// `parseCsvRows` never trims, by design, so a real export's trailing space arrives here.
		const name = at(row, cols.name).trim();
		const grouping = at(row, cols.grouping).trim();

		// A row with nothing identifying and no secret carries no entry.
		if (!url && !username && !password && !extra && !name) {
			skipped++;
			continue;
		}

		// The vault has no folders, so the path is kept as a field rather than dropped.
		const folder: RawField[] = grouping ? [{ key: "Folder", value: grouping }] : [];
		if (grouping) foldered++;

		if (url === SECURE_NOTE_URL) {
			const block = parseNoteBlock(extra);
			imported.push(
				block
					? fromNoteBlock(block, name, folder)
					: { type: "note", name, notes: extra || undefined, customFields: toCustomFields(folder) },
			);
			continue;
		}

		const link = url === NO_URL ? "" : url;
		imported.push({
			type: "login",
			name: name || hostLabel(link) || username,
			notes: extra || undefined,
			urls: link ? [link] : [],
			username,
			password,
			// Either a bare base32 secret or a full otpauth:// URI; parseTotp accepts both.
			totp: totp || undefined,
			customFields: toCustomFields(folder),
		});
	}

	if (foldered > 0) {
		warnings.push(
			`${foldered} item(s) were in a LastPass folder, kept as a "Folder" field because Bramble has no folders yet.`,
		);
	}
	return summarize(imported, skipped, warnings);
}
