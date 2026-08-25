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
	// Optional so pre-timestamp entries still validate.
	createdAt: z.number().optional(),
	updatedAt: z.number().optional(),
	lastUsedAt: z.number().optional(),
	archivedAt: z.number().optional(),
};

// Mirror of PasskeyCredential. Kept in lockstep with the interface in useVault.
const passkeyCredentialSchema = z.object({
	credentialId: z.string(),
	rpId: z.string(),
	rpName: z.string().optional(),
	userHandle: z.string(),
	userName: z.string().optional(),
	userDisplayName: z.string().optional(),
	alg: z.number(),
	publicKeyCose: z.string(),
	privateKey: z.string(),
	signCount: z.number(),
	createdAt: z.number(),
	lastUsedAt: z.number().optional(),
});

// Mirror of PasswordChange. Kept in lockstep with the interface in useVault.
const passwordChangeSchema = z.object({
	value: z.string(),
	changedAt: z.number(),
});

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
		passkeys: z.array(passkeyCredentialSchema).optional(),
		passwordChangelog: z.array(passwordChangeSchema).optional(),
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
	// candidate is validated by the schema tripwire above but deliberately returned even on a
	// mismatch (the bytes are AES-GCM-authenticated); Record<string, unknown> has no overlap with
	// EntryData's shape, so this is a genuine reinterpret, not a reducible cast.
	return candidate as unknown as EntryData;
}
