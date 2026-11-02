import { z } from "zod";
import type { CardEntryData, EntryData, LoginEntryData } from "../hooks/useVault";
import { cardBrand } from "../util/card";
import { deriveKeyType } from "../util/ssh";
import { mimeFor } from "../vault/mime";
import { normalizeTags } from "../vault/tags";
import { type RawField, readZippedJson, summarize, toCustomFields } from "./shared";
import type { ImportAttachment, ImportResult } from "./types";

// 1Password .1pux = a zip whose export.data is JSON (accounts > vaults > items), with each file
// under files/, named by the documentId export.data refers to it by.
// Schema is lenient except the top-level accounts array, which identifies the format.
// https://support.1password.com/1pux-format/
const fileSchema = z.object({
	fileName: z.string().nullish(),
	documentId: z.string().nullish(),
});
const valueSchema = z.object({
	string: z.string().nullish(),
	concealed: z.string().nullish(),
	totp: z.string().nullish(),
	creditCardNumber: z.string().nullish(),
	monthYear: z.number().nullish(),
	email: z.union([z.string(), z.object({ email_address: z.string().nullish() })]).nullish(),
	phone: z.string().nullish(),
	url: z.string().nullish(),
	date: z.number().nullish(),
	file: fileSchema.nullish(),
});
const fieldSchema = z.object({
	id: z.string().nullish(),
	title: z.string().nullish(),
	value: valueSchema.nullish(),
});
const itemSchema = z.object({
	categoryUuid: z.string().nullish(),
	overview: z
		.object({
			title: z.string().nullish(),
			url: z.string().nullish(),
			urls: z.array(z.object({ label: z.string().nullish(), url: z.string().nullish() })).nullish(),
			tags: z.array(z.string()).nullish(),
		})
		.nullish(),
	details: z
		.object({
			loginFields: z
				.array(z.object({ value: z.string().nullish(), designation: z.string().nullish() }))
				.nullish(),
			sections: z.array(z.object({ fields: z.array(fieldSchema).nullish() })).nullish(),
			notesPlain: z.string().nullish(),
			password: z.string().nullish(),
			// A Document item's own file.
			documentAttributes: fileSchema.nullish(),
		})
		.nullish(),
});
const exportSchema = z.object({
	accounts: z.array(
		z.object({ vaults: z.array(z.object({ items: z.array(itemSchema).nullish() })).nullish() }),
	),
});

type OpFile = z.infer<typeof fileSchema>;
type OpValue = z.infer<typeof valueSchema>;
type OpItem = z.infer<typeof itemSchema>;

const FORMAT_ERROR = "This doesn't look like a 1Password .1pux export.";

// Category codes we recognize. Everything else folds into a note.
const CAT_LOGIN = "001";
const CAT_CARD = "002";
const CAT_PASSWORD = "005";
const CAT_SSH_KEY = "114";
// Secure note (003) and every other category fall through to the note mapping.

// Collapse a section field's polymorphic value into text + masking + optional TOTP.
function readValue(v: OpValue | null | undefined): {
	text: string;
	hidden: boolean;
	totp?: string;
} {
	if (!v) return { text: "", hidden: false };
	if (typeof v.totp === "string") return { text: v.totp, hidden: false, totp: v.totp };
	if (typeof v.concealed === "string") return { text: v.concealed, hidden: true };
	if (typeof v.string === "string") return { text: v.string, hidden: false };
	if (typeof v.creditCardNumber === "string") return { text: v.creditCardNumber, hidden: false };
	if (typeof v.monthYear === "number") return { text: String(v.monthYear), hidden: false };
	if (typeof v.url === "string") return { text: v.url, hidden: false };
	if (typeof v.phone === "string") return { text: v.phone, hidden: false };
	if (typeof v.date === "number") return { text: String(v.date), hidden: false };
	if (typeof v.email === "string") return { text: v.email, hidden: false };
	if (v.email && typeof v.email === "object")
		return { text: v.email.email_address ?? "", hidden: false };
	return { text: "", hidden: false };
}

interface FlatField {
	id: string;
	title: string;
	text: string;
	hidden: boolean;
	totp?: string;
}

function flattenFields(item: OpItem): FlatField[] {
	const out: FlatField[] = [];
	for (const section of item.details?.sections ?? []) {
		for (const f of section.fields ?? []) {
			const r = readValue(f.value);
			out.push({ id: f.id ?? "", title: f.title || f.id || "Field", ...r });
		}
	}
	return out;
}

// Merge the legacy overview.url slot with the modern overview.urls[] list,
// de-duped and blank-stripped.
function allUrls(item: OpItem): string[] {
	const out: string[] = [];
	const push = (u: string | null | undefined) => {
		if (typeof u === "string" && u && !out.includes(u)) out.push(u);
	};
	push(item.overview?.url);
	for (const entry of item.overview?.urls ?? []) push(entry.url);
	return out;
}

function loginCredentials(item: OpItem): { username: string; password: string } {
	const fields = item.details?.loginFields ?? [];
	const username = fields.find((f) => f.designation === "username")?.value ?? "";
	const password =
		fields.find((f) => f.designation === "password")?.value ?? item.details?.password ?? "";
	return { username, password };
}

function mapLogin(item: OpItem, name: string, notes: string | undefined): LoginEntryData {
	const { username, password } = loginCredentials(item);
	const flat = flattenFields(item);
	const totp = flat.find((f) => f.totp)?.totp;
	const extras: RawField[] = flat
		.filter((f) => !f.totp)
		.map((f) => ({ key: f.title, value: f.text, hidden: f.hidden }));
	return {
		type: "login",
		name,
		notes,
		urls: allUrls(item),
		username,
		password,
		totp: totp || undefined,
		customFields: toCustomFields(extras),
	};
}

function mapCard(item: OpItem, name: string, notes: string | undefined): CardEntryData {
	let number = "";
	let cardholderName = "";
	let cvv = "";
	let expMonth = "";
	let expYear = "";
	const extras: RawField[] = [];
	for (const f of flattenFields(item)) {
		switch (f.id) {
			case "ccnum":
				number = f.text;
				break;
			case "cardholder":
				cardholderName = f.text;
				break;
			case "cvv":
				cvv = f.text;
				break;
			case "expiry": {
				// 1Password encodes expiry as one integer YYYYMM (e.g. 202703).
				const n = Number(f.text);
				if (Number.isFinite(n) && n > 0) {
					expYear = String(Math.floor(n / 100));
					expMonth = String(n % 100);
				}
				break;
			}
			case "type":
				break; // issuer name — we re-derive from the number
			default:
				extras.push({ key: f.title, value: f.text, hidden: f.hidden });
		}
	}
	return {
		type: "card",
		name,
		notes,
		cardholderName,
		number,
		brand: cardBrand(number),
		expMonth,
		expYear,
		cvv,
		customFields: toCustomFields(extras),
	};
}

// 1Password's SSH-key shape varies; detect keys heuristically from field text,
// fold the rest into custom fields.
function mapSshKey(item: OpItem, name: string, notes: string | undefined): EntryData {
	const flat = flattenFields(item);
	const privateKey = flat.find((f) => /PRIVATE KEY/.test(f.text))?.text ?? "";
	const publicKey = flat.find((f) => /^(ssh-|ecdsa-|sk-)/.test(f.text.trim()))?.text ?? "";
	const extras: RawField[] = flat
		.filter((f) => f.text !== privateKey && f.text !== publicKey)
		.map((f) => ({ key: f.title, value: f.text, hidden: f.hidden }));
	if (!privateKey && !publicKey) {
		return { type: "note", name, notes, customFields: toCustomFields(extras) };
	}
	return {
		type: "ssh-key",
		name,
		notes,
		publicKey,
		privateKey,
		keyType: deriveKeyType(publicKey, privateKey),
		customFields: toCustomFields(extras),
	};
}

function mapNote(item: OpItem, name: string, notes: string | undefined): EntryData {
	const extras: RawField[] = flattenFields(item).map((f) => ({
		key: f.title,
		value: f.text,
		hidden: f.hidden,
	}));
	return { type: "note", name, notes, customFields: toCustomFields(extras) };
}

// The files an item names: a Document item's own, then any on its fields.
function fileRefs(item: OpItem): { documentId: string; name: string }[] {
	const refs: { documentId: string; name: string }[] = [];
	const push = (f: OpFile | null | undefined) => {
		if (f?.documentId)
			refs.push({ documentId: f.documentId, name: f.fileName?.trim() || "attachment" });
	};
	push(item.details?.documentAttributes);
	for (const section of item.details?.sections ?? []) {
		for (const field of section.fields ?? []) push(field.value?.file);
	}
	return refs;
}

// files/<documentId>__<fileName>, keyed by documentId. 1Password's format page shows three
// underscores where real exports (as KeePassXC and Proton Pass read them) have two, and a
// documentId has none, so everything up to the first one is the id.
function filesById(files: Record<string, Uint8Array>): Map<string, Uint8Array> {
	const out = new Map<string, Uint8Array>();
	for (const [path, bytes] of Object.entries(files)) {
		const id = /(?:^|\/)files\/([^/_]+)_[^/]*$/.exec(path)?.[1];
		if (id) out.set(id, bytes);
	}
	return out;
}

/** Parse a 1Password .1pux export (zip) into importable entries. */
export function parseOnePassword(raw: string | Uint8Array): ImportResult {
	const { data: parsed, files } = readZippedJson(raw, {
		findData: (files) =>
			files["export.data"] ?? Object.entries(files).find(([p]) => p.endsWith("export.data"))?.[1],
		schema: exportSchema,
		corruptError: "Couldn't read this .1pux file. It may be corrupt.",
		formatError: FORMAT_ERROR,
	});

	const stored = filesById(files);
	const imported: EntryData[] = [];
	const attachments: ImportAttachment[] = [];
	let missing = 0;
	for (const account of parsed.accounts) {
		for (const vault of account.vaults ?? []) {
			for (const item of vault.items ?? []) {
				const name = item.overview?.title ?? "";
				const notes = item.details?.notesPlain || undefined;
				// 1Password's own tags, mapped straight across. Applied after the mapper
				// rather than threaded through all four of them, since it is the same for
				// every category.
				const tags = normalizeTags(item.overview?.tags);
				let entry: EntryData;
				switch (item.categoryUuid) {
					case CAT_LOGIN:
					case CAT_PASSWORD:
						entry = mapLogin(item, name, notes);
						break;
					case CAT_CARD:
						entry = mapCard(item, name, notes);
						break;
					case CAT_SSH_KEY:
						entry = mapSshKey(item, name, notes);
						break;
					default:
						entry = mapNote(item, name, notes);
				}
				const tagged = tags ? { ...entry, tags } : entry;
				imported.push(tagged);
				for (const { documentId, name } of fileRefs(item)) {
					const bytes = stored.get(documentId);
					if (!bytes) {
						missing++;
						continue;
					}
					attachments.push({
						entry: tagged,
						name,
						mime: mimeFor(name),
						source: { kind: "blob", blob: new Blob([bytes as BlobPart]) },
						size: bytes.length,
					});
				}
			}
		}
	}

	const warnings: string[] = [];
	if (missing > 0) {
		warnings.push(`${missing} attachment(s) are named in this export but not stored in it.`);
	}
	return summarize(imported, 0, warnings, attachments);
}
