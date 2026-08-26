import { z } from "zod";
import type { EntryData } from "../hooks/useVault";
import { cardBrand } from "../util/card";
import { normalizeTags } from "../vault/tags";
import { type RawField, readZippedJson, summarize, toCustomFields } from "./shared";
import type { ImportResult } from "./types";

// Proton Pass export: a zip holding data.json with a `vaults` map. Schema lenient except `vaults`.
// `content` is loose so the identity/unknown fold keeps unmodelled keys. State: 1 active, 2 trashed.
const extraFieldSchema = z.object({
	fieldName: z.string().nullish(),
	type: z.string().nullish(), // "text" | "hidden" | "totp"
	data: z.object({ content: z.string().nullish() }).nullish(),
});
const contentSchema = z.looseObject({
	itemEmail: z.string().nullish(),
	itemUsername: z.string().nullish(),
	username: z.string().nullish(),
	password: z.string().nullish(),
	urls: z.array(z.string()).nullish(),
	totpUri: z.string().nullish(),
	passkeys: z.array(z.unknown()).nullish(),
	cardholderName: z.string().nullish(),
	number: z.string().nullish(),
	verificationNumber: z.string().nullish(),
	expirationDate: z.string().nullish(),
	pin: z.string().nullish(),
});
const itemSchema = z.object({
	state: z.number().nullish(),
	aliasEmail: z.string().nullish(),
	data: z
		.object({
			type: z.string().nullish(),
			metadata: z.object({ name: z.string().nullish(), note: z.string().nullish() }).nullish(),
			content: contentSchema.nullish(),
			extraFields: z.array(extraFieldSchema).nullish(),
		})
		.nullish(),
});
const exportSchema = z.object({
	vaults: z.record(
		z.string(),
		z.object({ name: z.string().nullish(), items: z.array(itemSchema).nullish() }),
	),
});

type PpExtraField = z.infer<typeof extraFieldSchema>;

const FORMAT_ERROR = "This doesn't look like a Proton Pass export.";
const STATE_TRASHED = 2;

function mapExtraFields(extra: PpExtraField[] | null | undefined): RawField[] {
	if (!extra) return [];
	return extra.map((f) => ({
		key: f.fieldName ?? "",
		value: f.data?.content ?? "",
		hidden: f.type === "hidden",
	}));
}

/** Split Proton card expiry; handles both "MMYYYY" and "YYYY-MM" forms. */
function splitExpiry(raw: string | null | undefined): { expMonth: string; expYear: string } {
	if (!raw) return { expMonth: "", expYear: "" };
	if (raw.includes("-")) {
		const [year, month] = raw.split("-");
		return { expMonth: String(Number(month ?? "")), expYear: year ?? "" };
	}
	return { expMonth: String(Number(raw.slice(0, 2))), expYear: raw.slice(2) };
}

/** Parse a Proton Pass zip export into Bramble entries. Throws on non-Proton input. */
export function parseProtonPass(raw: string | Uint8Array): ImportResult {
	const parsed = readZippedJson(raw, {
		findData: (files) => Object.entries(files).find(([p]) => p.endsWith("data.json"))?.[1],
		schema: exportSchema,
		corruptError: "Couldn't read this Proton Pass file. It may be corrupt.",
		formatError: FORMAT_ERROR,
	});

	const imported: EntryData[] = [];
	const warnings: string[] = [];

	for (const vault of Object.values(parsed.vaults)) {
		// Proton organises by vault, which is the closest thing its export has to a tag.
		const tags = normalizeTags([vault.name]);
		for (const item of vault.items ?? []) {
			if (item.state === STATE_TRASHED) continue;
			const d = item.data ?? {};
			const name = d.metadata?.name ?? "";
			const notes = d.metadata?.note || undefined;
			const content = d.content ?? {};
			const extra = mapExtraFields(d.extraFields);
			const totpExtra = d.extraFields?.find((f) => f.type === "totp")?.data?.content;

			switch (d.type) {
				case "login":
				case "alias": {
					if (content.passkeys?.length) {
						warnings.push(`"${name}" has a passkey, which can't be imported yet.`);
					}
					const username =
						content.itemUsername || content.username || content.itemEmail || item.aliasEmail || "";
					// Keep the email only when distinct from the chosen username.
					const email = content.itemEmail;
					const emailField: RawField[] =
						email && email !== username ? [{ key: "email", value: email }] : [];
					// Keep every non-blank URL so multi-URL logins survive.
					const urls = (content.urls ?? []).filter(
						(u): u is string => typeof u === "string" && u.length > 0,
					);
					imported.push({
						type: "login",
						name,
						notes,
						tags,
						urls,
						username,
						password: content.password ?? "",
						totp: content.totpUri || totpExtra || undefined,
						customFields: toCustomFields([
							...emailField,
							...extra.filter((f) => f.value !== (content.totpUri || totpExtra)),
						]),
					});
					break;
				}
				case "creditCard": {
					const { expMonth, expYear } = splitExpiry(content.expirationDate);
					const number = content.number ?? "";
					const pin: RawField[] = content.pin
						? [{ key: "PIN", value: content.pin, hidden: true }]
						: [];
					imported.push({
						type: "card",
						name,
						notes,
						tags,
						cardholderName: content.cardholderName ?? "",
						number,
						brand: cardBrand(number),
						expMonth,
						expYear,
						cvv: content.verificationNumber ?? "",
						customFields: toCustomFields([...pin, ...extra]),
					});
					break;
				}
				case "note":
					imported.push({
						type: "note",
						name,
						notes,
						tags,
						customFields: toCustomFields(extra),
					});
					break;
				default:
					// identity / unknown types: a note folding content + extras in.
					imported.push({
						type: "note",
						name,
						notes,
						tags,
						customFields: toCustomFields([
							...Object.entries(content).map(([key, value]) => ({
								key,
								value: typeof value === "string" ? value : "",
							})),
							...extra,
						]),
					});
			}
		}
	}

	return summarize(imported, 0, warnings);
}
