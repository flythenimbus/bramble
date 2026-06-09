import { z } from "zod";
import type { EntryData } from "../hooks/useVault";

// Runtime mirror of EntryData; the z.ZodType<EntryData> annotation fails the
// build if schema and union diverge.

const customFieldSchema = z.object({
	key: z.string(),
	value: z.string(),
	hidden: z.boolean().optional(),
});

const baseEntryFields = {
	name: z.string(),
	notes: z.string().optional(),
	customFields: z.array(customFieldSchema).optional(),
};

/** Runtime validation schema for a decrypted entry, by `type`. */
export const entryDataSchema: z.ZodType<EntryData> = z.discriminatedUnion("type", [
	z.object({
		...baseEntryFields,
		type: z.literal("login"),
		urls: z.array(z.string()),
		username: z.string(),
		password: z.string(),
		totp: z.string().optional(),
		breach: z.object({ leaked: z.boolean(), checkedAt: z.number() }).optional(),
		autofillEnabled: z.boolean().optional(),
		autoSubmit: z.boolean().optional(),
		subdomainMatch: z.enum(["etld1", "exact", "subdomain"]).optional(),
	}),
	z.object({
		...baseEntryFields,
		type: z.literal("card"),
		cardholderName: z.string(),
		number: z.string(),
		brand: z.string().optional(),
		expMonth: z.string(),
		expYear: z.string(),
		cvv: z.string(),
	}),
	z.object({ ...baseEntryFields, type: z.literal("note") }),
	z.object({
		...baseEntryFields,
		type: z.literal("ssh-key"),
		publicKey: z.string(),
		privateKey: z.string(),
		passphrase: z.string().optional(),
		keyType: z.string().optional(),
	}),
]);

/**
 * Migrate a decrypted entry to the current shape: typeless entries become
 * logins, legacy `url: string` collapses into `urls`. Never drops the entry on
 * a schema miss (unknown keys survive for forward-compat).
 */
export function normalizeEntryData(raw: Record<string, unknown>): EntryData {
	const candidate: Record<string, unknown> = raw.type ? { ...raw } : { type: "login", ...raw };
	if (candidate.type === "login" && !Array.isArray(candidate.urls)) {
		const legacy = typeof candidate.url === "string" ? candidate.url : "";
		candidate.urls = legacy ? [legacy] : [];
		delete candidate.url;
	}
	// Tripwire for our own write/migration bugs (bytes are AES-GCM-authenticated).
	if (!entryDataSchema.safeParse(candidate).success) {
		// WARNING: log shape only, never values: candidate holds decrypted secrets.
		const type = typeof candidate?.type === "string" ? candidate.type : "<missing>";
		const keys = Object.keys(candidate ?? {})
			.sort()
			.join(",");
		console.error(`[vault] decrypted entry has an unexpected shape (type=${type}, keys=${keys})`);
	}
	return candidate as unknown as EntryData;
}
