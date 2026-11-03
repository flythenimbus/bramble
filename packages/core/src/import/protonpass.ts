import { z } from "zod";
import type { EntryData } from "../hooks/useVault";
import { cardBrand } from "../util/card";
import { mimeFor } from "../vault/mime";
import { normalizeTags } from "../vault/tags";
import { type ConversionTally, systemicFailureWarning } from "./passkey-fields";
import { importProtonPasskeys } from "./protonpass-passkey";
import {
	missingFilesWarning,
	type RawField,
	readZippedJson,
	summarize,
	toCustomFields,
} from "./shared";
import type { ImportAttachment, ImportParserContext, ImportResult } from "./types";

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
	autofillUrls: z.array(z.unknown()).nullish(),
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
	createTime: z.number().nullish(),
	aliasEmail: z.string().nullish(),
	shareId: z.string().nullish(),
	files: z.array(z.unknown()).nullish(),
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
type PpContent = z.infer<typeof contentSchema>;
// Each website carries its autofill rule. `urls` repeats only the Default ones.
const autofillUrlSchema = z.object({ url: z.string(), mode: z.unknown() });

const FORMAT_ERROR = "This doesn't look like a Proton Pass export.";
const STATE_TRASHED = 2;
const MODE_DEFAULT = 0;
const MODE_NEVER = 2;
const NEVER_FIELD = "Never autofill on";

/** Every website on a login. A Never one goes to a field so it can't autofill there. */
function loginUrls(content: PpContent): { urls: string[]; never: RawField[]; ruled: number } {
	const out = { urls: [] as string[], never: [] as RawField[], ruled: 0 };
	const seen = new Set<string>();
	for (const raw of content.autofillUrls ?? []) {
		const parsed = autofillUrlSchema.safeParse(raw);
		if (!parsed.success || !parsed.data.url) continue;
		const { url, mode } = parsed.data;
		seen.add(url);
		if (mode === MODE_NEVER) {
			out.never.push({ key: NEVER_FIELD, value: url });
			continue;
		}
		out.urls.push(url);
		if (mode != null && mode !== MODE_DEFAULT) out.ruled++;
	}
	// An export from before autofillUrls, or one whose lists disagree, loses nothing.
	for (const url of content.urls ?? []) {
		if (url && !seen.has(url)) {
			seen.add(url);
			out.urls.push(url);
		}
	}
	return out;
}

/** Proton's getHashCode: the Java string hash, as a 32-bit int. */
function hashCode(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
	return h;
}

/** As Proton's sanitizeFileName does on the way into the zip. */
const sanitize = (name: string) => name.replace(/[/\\]/g, "_").trim();

/** Undo Proton's `<base>.<hex shareId hash><hex fileID hash><ext>`; a name that doesn't fit is kept. */
function originalName(exportName: string, shareId: string | null | undefined): string {
	if (!shareId) return exportName;
	const shareHash = Math.abs(hashCode(shareId)).toString(16);
	const m = new RegExp(`^(.*)\\.${shareHash}[0-9a-f]+(\\.[^.]+)?$`).exec(exportName);
	return (m && `${m[1]}${m[2] ?? ""}`) || exportName;
}

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
export async function parseProtonPass(
	raw: string | Uint8Array,
	context: ImportParserContext,
): Promise<ImportResult> {
	const { data: parsed, files } = readZippedJson(raw, {
		findData: (files) => Object.entries(files).find(([p]) => p.endsWith("data.json"))?.[1],
		schema: exportSchema,
		corruptError: "Couldn't read this Proton Pass file. It may be corrupt.",
		formatError: FORMAT_ERROR,
	});

	const imported: EntryData[] = [];
	const warnings: string[] = [];
	const importedAt = Date.now();
	const tally: ConversionTally = { converted: 0, failed: 0 };
	// Files sit in files/ beside data.json, named as the item's `files` lists them.
	const root =
		Object.keys(files)
			.find((p) => p.endsWith("data.json"))
			?.slice(0, -"data.json".length) ?? "";
	const attachments: ImportAttachment[] = [];
	let missingFiles = 0;
	let ruledUrls = 0;
	let neverUrls = 0;

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

			let entry: EntryData;
			switch (d.type) {
				case "login":
				case "alias": {
					const createdAt = item.createTime ? item.createTime * 1000 : undefined;
					const passkeys = await importProtonPasskeys(
						content.passkeys,
						name,
						createdAt,
						importedAt,
						context,
						warnings,
						tally,
					);
					const username =
						content.itemUsername || content.username || content.itemEmail || item.aliasEmail || "";
					// Keep the email only when distinct from the chosen username.
					const email = content.itemEmail;
					const emailField: RawField[] =
						email && email !== username ? [{ key: "email", value: email }] : [];
					const { urls, never, ruled } = loginUrls(content);
					ruledUrls += ruled;
					neverUrls += never.length;
					entry = {
						type: "login",
						name,
						notes,
						tags,
						urls,
						// One rule per login here, so a narrowed website tightens the whole login.
						...(ruled > 0 ? { subdomainMatch: "exact" as const } : {}),
						username,
						password: content.password ?? "",
						totp: content.totpUri || totpExtra || undefined,
						customFields: toCustomFields([
							...emailField,
							...never,
							...extra.filter((f) => f.value !== (content.totpUri || totpExtra)),
						]),
						passkeys,
					};
					break;
				}
				case "creditCard": {
					const { expMonth, expYear } = splitExpiry(content.expirationDate);
					const number = content.number ?? "";
					const pin: RawField[] = content.pin
						? [{ key: "PIN", value: content.pin, hidden: true }]
						: [];
					entry = {
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
					};
					break;
				}
				case "note":
					entry = {
						type: "note",
						name,
						notes,
						tags,
						customFields: toCustomFields(extra),
					};
					break;
				default:
					// identity / unknown types: a note folding content + extras in.
					entry = {
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
					};
			}
			imported.push(entry);

			for (const listed of item.files ?? []) {
				const stored = typeof listed === "string" ? sanitize(listed) : "";
				const bytes = stored ? files[`${root}files/${stored}`] : undefined;
				if (!bytes) {
					missingFiles++;
					continue;
				}
				const fileName = originalName(stored, item.shareId);
				attachments.push({
					entry,
					name: fileName,
					mime: mimeFor(fileName),
					source: { kind: "blob", blob: new Blob([bytes as BlobPart]) },
					size: bytes.length,
				});
			}
		}
	}

	if (ruledUrls > 0) {
		warnings.push(
			`${ruledUrls} website(s) had a Proton autofill rule Bramble doesn't have, so their logins now match the exact site only.`,
		);
	}
	if (neverUrls > 0) {
		warnings.push(
			`${neverUrls} website(s) were set to never autofill in Proton, so they're kept in a "${NEVER_FIELD}" field instead of the login's websites.`,
		);
	}
	if (missingFiles > 0) warnings.push(missingFilesWarning(missingFiles));

	const systemic = systemicFailureWarning(tally, "export");
	if (systemic) warnings.push(systemic);

	return summarize(imported, 0, warnings, attachments);
}
