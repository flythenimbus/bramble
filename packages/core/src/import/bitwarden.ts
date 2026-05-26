import { z } from "zod";
import type { EntryData } from "../hooks/useVault";
import { cardBrand } from "../util/card";
import { deriveKeyType } from "../util/ssh";
import { asText, type RawField, summarize, toCustomFields } from "./shared";
import type { ImportResult } from "./types";

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
			uris: z.array(z.object({ uri: z.string().nullish() })).nullish(),
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

function mapFields(fields: BwField[] | null | undefined): RawField[] {
	if (!fields) return [];
	return fields
		.filter((f) => f.type !== 3)
		.map((f) => ({ key: f.name ?? "", value: f.value ?? "", hidden: f.type === 1 }));
}

export function parseBitwarden(raw: string | Uint8Array): ImportResult {
	let json: unknown;
	try {
		json = JSON.parse(asText(raw));
	} catch {
		throw new Error(FORMAT_ERROR);
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
			imported.push({
				type: "login",
				name,
				notes,
				url: login.uris?.find((u) => u.uri)?.uri ?? "",
				username: login.username ?? "",
				password: login.password ?? "",
				totp: login.totp || undefined,
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
