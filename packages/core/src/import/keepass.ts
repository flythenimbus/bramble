import { XMLParser } from "fast-xml-parser";
import type { EntryData } from "../hooks/useVault";
import { asText, type RawField, summarize, toCustomFields } from "./shared";
import type { ImportResult } from "./types";

// KeePass 2.x XML export: entries under nested Groups, each with String{Key,Value}
// pairs plus a History subtree of past revisions we must NOT import.
const FORMAT_ERROR = "This doesn't look like a KeePass 2.x XML export.";
const RECYCLE_BIN = "Recycle Bin";
const STANDARD_KEYS = new Set(["Title", "UserName", "Password", "URL", "Notes"]);

// fast-xml-parser yields an object for a single child, an array for repeated.
function toArray<T>(v: T | T[] | undefined): T[] {
	if (v == null) return [];
	return Array.isArray(v) ? v : [v];
}

interface XmlValue {
	"#text"?: string;
	"@_ProtectInMemory"?: string;
}
interface XmlString {
	Key?: string;
	Value?: string | XmlValue;
}
interface XmlEntry {
	String?: XmlString | XmlString[];
}
interface XmlGroup {
	Name?: string;
	Group?: XmlGroup | XmlGroup[];
	Entry?: XmlEntry | XmlEntry[];
}

function readValue(value: string | XmlValue | undefined): { text: string; hidden: boolean } {
	if (value == null) return { text: "", hidden: false };
	if (typeof value === "string") return { text: value, hidden: false };
	return { text: value["#text"] ?? "", hidden: value["@_ProtectInMemory"] === "True" };
}

// Collect entries from a group tree, skipping the Recycle Bin. History entries
// nest under Entry.History.Entry, never Group.Entry, so walking groups excludes them.
function collectEntries(group: XmlGroup): XmlEntry[] {
	if (group.Name === RECYCLE_BIN) return [];
	const here = toArray(group.Entry);
	const nested = toArray(group.Group).flatMap(collectEntries);
	return [...here, ...nested];
}

/** Map flat KeePass String fields to a login entry. Shared by the XML export and decrypted .kdbx paths. */
export function mapKeepassFields(fields: RawField[]): EntryData {
	let name = "";
	let username = "";
	let password = "";
	let url = "";
	let notes = "";
	let totp: string | undefined;
	const extras: RawField[] = [];

	for (const { key, value, hidden } of fields) {
		switch (key) {
			case "Title":
				name = value;
				break;
			case "UserName":
				username = value;
				break;
			case "Password":
				password = value;
				break;
			case "URL":
				url = value;
				break;
			case "Notes":
				notes = value;
				break;
			case "otp":
				// KeePassXC: a full otpauth:// URI.
				totp = value || totp;
				break;
			case "TOTP Seed":
				// KeeOtp/KeeWeb plugins: a bare base32 secret.
				if (!totp) totp = value;
				break;
			case "TOTP Settings":
				break; // companion to TOTP Seed (period/digits), not needed
			default:
				if (!STANDARD_KEYS.has(key)) extras.push({ key, value, hidden });
		}
	}

	return {
		type: "login",
		name,
		notes: notes || undefined,
		// KeePass 2.x has one URL per entry; wrap to the array shape.
		urls: url ? [url] : [],
		username,
		password,
		totp: totp || undefined,
		customFields: toCustomFields(extras),
	};
}

function mapEntry(entry: XmlEntry): EntryData {
	const fields: RawField[] = toArray(entry.String).map((s) => {
		const { text, hidden } = readValue(s.Value);
		return { key: String(s.Key ?? ""), value: text, hidden };
	});
	return mapKeepassFields(fields);
}

/** Parse a KeePass 2.x XML export into importable login entries. */
export function parseKeePass(raw: string | Uint8Array): ImportResult {
	const text = asText(raw);
	let parsed: { KeePassFile?: { Root?: XmlGroup } };
	try {
		parsed = new XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: "@_",
			parseTagValue: false,
			// Disable entity processing to block billion-laughs payloads.
			processEntities: false,
		}).parse(text);
	} catch {
		throw new Error(FORMAT_ERROR);
	}
	const root = parsed?.KeePassFile?.Root;
	if (!root) throw new Error(FORMAT_ERROR);

	const entries = toArray(root.Group).flatMap(collectEntries);
	const imported = entries.map(mapEntry);
	return summarize(imported, 0, []);
}
