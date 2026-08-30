import { XMLParser } from "fast-xml-parser";
import type { EntryData } from "../hooks/useVault";
import { normalizeTags } from "../vault/tags";
import { asText, type RawField, summarize, toCustomFields } from "./shared";
import type { ImportResult } from "./types";

// KeePass 2.x XML export: entries under nested Groups, each with String{Key,Value}
// pairs plus a History subtree of past revisions we must NOT import.
const FORMAT_ERROR = "This doesn't look like a KeePass 2.x XML export.";
const RECYCLE_BIN = "Recycle Bin";
const STANDARD_KEYS = new Set(["Title", "UserName", "Password", "URL", "Notes", "Tags", "Group"]);

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
	/** KeePass's own tag element, comma-separated. */
	Tags?: string;
}
interface XmlGroup {
	Name?: string;
	Group?: XmlGroup | XmlGroup[];
	Entry?: XmlEntry | XmlEntry[];
}

// Entity processing is off in the parser below to block expansion bombs, which also switches off
// the five PREDEFINED entities and numeric character references. Those cannot recurse and carry no
// DoS risk, so decode them here; leaving them raw silently corrupts any password containing & < > "
// or '. One pass, never sequential replaces: `&amp;lt;` must decode to `&lt;`, not to `<`.
const XML_ENTITY = /&(?:(amp|lt|gt|quot|apos)|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/g;
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

export function unescapeXml(value: string): string {
	if (!value.includes("&")) return value;
	return value.replace(XML_ENTITY, (whole, name: string | undefined, dec, hex) => {
		if (name) return NAMED_ENTITIES[name] ?? whole;
		const code = Number.parseInt(dec ?? hex, dec ? 10 : 16);
		// Out of range or a lone surrogate: leave the text exactly as the file had it rather
		// than inventing a replacement character inside someone's password.
		if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
		return String.fromCodePoint(code);
	});
}

function readValue(value: string | XmlValue | undefined): { text: string; hidden: boolean } {
	if (value == null) return { text: "", hidden: false };
	if (typeof value === "string") return { text: unescapeXml(value), hidden: false };
	return {
		text: unescapeXml(value["#text"] ?? ""),
		hidden: value["@_ProtectInMemory"] === "True",
	};
}

/** An entry plus the group path it was found under, which the mapper turns into tags. */
interface FoundEntry {
	entry: XmlEntry;
	path: string[];
}

// Collect entries from a group tree, skipping the Recycle Bin. History entries
// nest under Entry.History.Entry, never Group.Entry, so walking groups excludes them.
//
// The group path travels with each entry rather than being flattened away: groups are the
// only organisation a KeePass database has, and dropping them was the whole reason an
// imported vault arrived unsorted.
function collectEntries(group: XmlGroup, parents: string[] = []): FoundEntry[] {
	const name = group.Name ? unescapeXml(group.Name) : undefined;
	if (name === RECYCLE_BIN) return [];
	const path = name ? [...parents, name] : parents;
	const here = toArray(group.Entry).map((entry) => ({ entry, path }));
	const nested = toArray(group.Group).flatMap((g) => collectEntries(g, path));
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
	// KeePass organises entirely by group, and its `<Tags>` element is the closest thing
	// it has to ours. Both arrive as synthetic String pairs (see TAGS_KEY / GROUP_KEY in
	// core-rust/src/kdbx.rs) and both become tags, so a database's organisation survives
	// the import instead of being flattened away.
	const tags: string[] = [];

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
			case "Tags":
				// KeePass joins its tags with commas (and tolerates semicolons).
				tags.push(...value.split(/[,;]/));
				break;
			case "Group":
				// One tag per level, so "Work/Clients/Acme" is findable by any of them.
				tags.push(...value.split("/"));
				break;
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
		tags: normalizeTags(tags),
	};
}

function mapEntry({ entry, path }: FoundEntry): EntryData {
	const fields: RawField[] = toArray(entry.String).map((s) => {
		const { text, hidden } = readValue(s.Value);
		return { key: unescapeXml(String(s.Key ?? "")), value: text, hidden };
	});
	// Handed to the mapper as the same synthetic pairs the .kdbx path produces, so both
	// formats reach `mapKeepassFields` looking identical.
	if (entry.Tags) fields.push({ key: "Tags", value: unescapeXml(entry.Tags), hidden: false });
	// Skip the root group: it names the database, not a folder inside it.
	const folders = path.slice(1).join("/");
	if (folders) fields.push({ key: "Group", value: folders, hidden: false });
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
			// Off to block expansion bombs (the parser would expand DOCTYPE-declared entities).
			// The predefined entities it also disables are decoded by `unescapeXml` above.
			processEntities: false,
		}).parse(text);
	} catch {
		throw new Error(FORMAT_ERROR);
	}
	const root = parsed?.KeePassFile?.Root;
	if (!root) throw new Error(FORMAT_ERROR);

	const entries = toArray(root.Group).flatMap((g) => collectEntries(g));
	const imported = entries.map(mapEntry);
	return summarize(imported, 0, []);
}
