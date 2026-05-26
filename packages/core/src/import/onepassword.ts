import { strFromU8, unzipSync } from "fflate";
import { z } from "zod";
import type { CardEntryData, EntryData, LoginEntryData } from "../hooks/useVault";
import { cardBrand } from "../util/card";
import { deriveKeyType } from "../util/ssh";
import { asBytes, type RawField, summarize, toCustomFields } from "./shared";
import type { ImportResult } from "./types";

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
		})
		.nullish(),
});
const exportSchema = z.object({
	accounts: z.array(
		z.object({ vaults: z.array(z.object({ items: z.array(itemSchema).nullish() })).nullish() }),
	),
});

type OpValue = z.infer<typeof valueSchema>;
type OpItem = z.infer<typeof itemSchema>;

const FORMAT_ERROR = "This doesn't look like a 1Password .1pux export.";

// Category codes we recognize. Everything else folds into a note.
const CAT_LOGIN = "001";
const CAT_CARD = "002";
const CAT_PASSWORD = "005";
const CAT_SSH_KEY = "114";
// Secure note (003) and every other category fall through to the note mapping.

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

function primaryUrl(item: OpItem): string {
	return item.overview?.url || item.overview?.urls?.find((u) => u.url)?.url || "";
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
		url: primaryUrl(item),
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

export function parseOnePassword(raw: string | Uint8Array): ImportResult {
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(asBytes(raw));
	} catch {
		throw new Error("Couldn't read this .1pux file — it may be corrupt.");
	}
	const dataFile =
		files["export.data"] ?? Object.entries(files).find(([p]) => p.endsWith("export.data"))?.[1];
	if (!dataFile) throw new Error(FORMAT_ERROR);

	let json: unknown;
	try {
		json = JSON.parse(strFromU8(dataFile));
	} catch {
		throw new Error(FORMAT_ERROR);
	}
	const parsed = exportSchema.safeParse(json);
	if (!parsed.success) throw new Error(FORMAT_ERROR);

	const imported: EntryData[] = [];
	for (const account of parsed.data.accounts) {
		for (const vault of account.vaults ?? []) {
			for (const item of vault.items ?? []) {
				const name = item.overview?.title ?? "";
				const notes = item.details?.notesPlain || undefined;
				switch (item.categoryUuid) {
					case CAT_LOGIN:
					case CAT_PASSWORD:
						imported.push(mapLogin(item, name, notes));
						break;
					case CAT_CARD:
						imported.push(mapCard(item, name, notes));
						break;
					case CAT_SSH_KEY:
						imported.push(mapSshKey(item, name, notes));
						break;
					default:
						imported.push(mapNote(item, name, notes));
				}
			}
		}
	}

	return summarize(imported, 0, []);
}
