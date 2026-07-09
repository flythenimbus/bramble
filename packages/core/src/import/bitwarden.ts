import { z } from "zod";
import type { SubdomainMatchMode } from "../adapters/autofill";
import type { EntryData } from "../hooks/useVault";
import { cardBrand } from "../util/card";
import { deriveKeyType } from "../util/ssh";
import { asText, type RawField, summarize, toCustomFields } from "./shared";
import type { ImportResult } from "./types";

// Lenient schema for unencrypted Bitwarden JSON: only `items` is required.
// https://bitwarden.com/help/condition-bitwarden-import/
const fieldSchema = z.object({
	name: z.string().nullish(),
	value: z.string().nullish(),
	type: z.number().nullish(), // 0 text, 1 hidden, 2 boolean, 3 linked
});
const itemSchema = z.object({
	type: z.number().nullish(), // 1 login, 2 secureNote, 3 card, 4 identity, 5 sshKey
	name: z.string().nullish(),
	notes: z.string().nullish(),
	fields: z.array(fieldSchema).nullish(),
	login: z
		.object({
			// `match` is Bitwarden's per-URI UriMatchType: 0 Domain (base domain, the default),
			// 1 Host, 2 StartsWith, 3 Exact, 4 RegularExpression, 5 Never; null = the account
			// default (base domain). https://bitwarden.com/help/uri-match-detection/
			uris: z.array(z.object({ uri: z.string().nullish(), match: z.number().nullish() })).nullish(),
			username: z.string().nullish(),
			password: z.string().nullish(),
			totp: z.string().nullish(),
			fido2Credentials: z.array(z.unknown()).nullish(),
		})
		.nullish(),
	card: z
		.object({
			cardholderName: z.string().nullish(),
			brand: z.string().nullish(),
			number: z.string().nullish(),
			expMonth: z.string().nullish(),
			expYear: z.string().nullish(),
			code: z.string().nullish(),
		})
		.nullish(),
	identity: z.record(z.string(), z.unknown()).nullish(),
	sshKey: z.object({ privateKey: z.string().nullish(), publicKey: z.string().nullish() }).nullish(),
});
const exportSchema = z.object({ items: z.array(itemSchema) });

type BwField = z.infer<typeof fieldSchema>;

const FORMAT_ERROR = "This doesn't look like a Bitwarden JSON export.";
// An encrypted / "Password protected" export carries `encrypted: true` (unencrypted ones
// carry `encrypted: false`) and its entries live in an opaque `data` blob, not an `items`
// array - so it would otherwise trip FORMAT_ERROR and look like "not Bitwarden".
const ENCRYPTED_ERROR =
	'This is an encrypted (password-protected) Bitwarden export. Re-export from Bitwarden as a plain .json with "Password protected" turned off, then import that file.';

/**
 * Map Bitwarden's per-URI match detection onto our per-entry `subdomainMatch`. Bitwarden's
 * default (0 Domain / null) is base-domain matching = our "etld1" (matches all subdomains),
 * so it stays the default (undefined). Any URI the user narrowed away from that default
 * (Host / StartsWith / Exact / Regex / Never) tightens the whole entry to "exact" — because
 * our model has one match mode per entry, not per URI, and tightening is the safe direction.
 */
function subdomainMatchFor(
	uris: { match?: number | null }[] | null | undefined,
): SubdomainMatchMode | undefined {
	const tightened = (uris ?? []).some((u) => typeof u.match === "number" && u.match !== 0);
	return tightened ? "exact" : undefined;
}

/** Map Bitwarden custom fields. Drops type 3 (linked refs); type 1 is hidden. */
function mapFields(fields: BwField[] | null | undefined): RawField[] {
	if (!fields) return [];
	return fields
		.filter((f) => f.type !== 3)
		.map((f) => ({ key: f.name ?? "", value: f.value ?? "", hidden: f.type === 1 }));
}

/** Parse an unencrypted Bitwarden JSON export into Bramble entries. Throws on non-Bitwarden input. */
export function parseBitwarden(raw: string | Uint8Array): ImportResult {
	let json: unknown;
	try {
		json = JSON.parse(asText(raw));
	} catch {
		throw new Error(FORMAT_ERROR);
	}
	// Catch a password-protected export before the generic format check, so the user gets a
	// fixable message instead of "not Bitwarden".
	if (json !== null && typeof json === "object") {
		const o = json as Record<string, unknown>;
		if (o.encrypted === true || o.passwordProtected === true) throw new Error(ENCRYPTED_ERROR);
	}
	const parsed = exportSchema.safeParse(json);
	if (!parsed.success) throw new Error(FORMAT_ERROR);

	const imported: EntryData[] = [];
	const warnings: string[] = [];

	for (const item of parsed.data.items) {
		const name = item.name ?? "";
		const notes = item.notes || undefined;
		const fields = mapFields(item.fields);

		if (item.type === 1) {
			const login = item.login ?? {};
			if (login.fido2Credentials?.length) {
				warnings.push(`"${name}" has a passkey, which can't be imported yet.`);
			}
			// Keep all URLs; collapse their per-URI match detection into one per-entry mode.
			const urls = (login.uris ?? [])
				.map((u) => u.uri)
				.filter((u): u is string => typeof u === "string" && u.length > 0);
			imported.push({
				type: "login",
				name,
				notes,
				urls,
				username: login.username ?? "",
				password: login.password ?? "",
				totp: login.totp || undefined,
				subdomainMatch: subdomainMatchFor(login.uris),
				customFields: toCustomFields(fields),
			});
		} else if (item.type === 3) {
			const card = item.card ?? {};
			const number = card.number ?? "";
			imported.push({
				type: "card",
				name,
				notes,
				cardholderName: card.cardholderName ?? "",
				number,
				brand: card.brand || cardBrand(number),
				expMonth: card.expMonth ?? "",
				expYear: card.expYear ?? "",
				cvv: card.code ?? "",
				customFields: toCustomFields(fields),
			});
		} else if (item.type === 5) {
			const key = item.sshKey ?? {};
			const publicKey = key.publicKey ?? "";
			const privateKey = key.privateKey ?? "";
			imported.push({
				type: "ssh-key",
				name,
				notes,
				publicKey,
				privateKey,
				keyType: deriveKeyType(publicKey, privateKey),
				customFields: toCustomFields(fields),
			});
		} else {
			// secureNote (2), identity (4), unknown: a note, with identity sub-fields folded in.
			const identity = item.identity
				? Object.entries(item.identity).map(([key, value]) => ({
						key,
						value: value == null ? "" : String(value),
					}))
				: [];
			imported.push({
				type: "note",
				name,
				notes,
				customFields: toCustomFields([...fields, ...identity]),
			});
		}
	}

	return summarize(imported, 0, warnings);
}
