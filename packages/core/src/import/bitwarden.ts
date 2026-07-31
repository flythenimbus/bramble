import { z } from "zod";
import type { SubdomainMatchMode } from "../adapters/autofill";
import type { EntryData, PasskeyCredential } from "../hooks/useVault";
import { base64UrlToBase64, base64UrlToBytes, bytesToBase64, hexToBytes } from "../util/bytes";
import { cardBrand } from "../util/card";
import { deriveKeyType } from "../util/ssh";
import { COSE_ES256 } from "../vault/passkey";
import { asText, type RawField, summarize, toCustomFields } from "./shared";
import type { ImportParserContext, ImportResult } from "./types";

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
	creationDate: z.string().nullish(),
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

// Validate credentials independently so one malformed child never rejects its parent login.
const passkeySchema = z.object({
	credentialId: z.string(),
	keyType: z.string(),
	keyAlgorithm: z.string(),
	keyCurve: z.string(),
	keyValue: z.string(),
	rpId: z.string(),
	rpName: z.string().nullish(),
	userHandle: z.string(),
	userName: z.string().nullish(),
	userDisplayName: z.string().nullish(),
	counter: z.string().nullish(),
	creationDate: z.string().nullish(),
});
// Ignore `discoverable` so Bramble preserves every otherwise valid credential.

type BwField = z.infer<typeof fieldSchema>;

const FORMAT_ERROR = "This doesn't look like a Bitwarden JSON export.";
// An encrypted / "Password protected" export carries `encrypted: true` (unencrypted ones
// carry `encrypted: false`) and its entries live in an opaque `data` blob, not an `items`
// array - so it would otherwise trip FORMAT_ERROR and look like "not Bitwarden".
const ENCRYPTED_ERROR =
	'This is an encrypted (password-protected) Bitwarden export. Re-export from Bitwarden as a plain .json with "Password protected" turned off, then import that file.';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i;
const MAX_CREDENTIAL_ID_BYTES = 1023;
const MAX_USER_HANDLE_BYTES = 64;
const MAX_RP_ID_LENGTH = 253;
// Cap bridge input at 1 KiB while allowing optional PKCS#8 metadata.
const MAX_PKCS8_BYTES = 1024;

function maxBase64UrlLength(decodedBytes: number): number {
	return Math.ceil((decodedBytes * 4) / 3);
}

function strictBase64Url(value: string, maxDecodedBytes: number): string {
	if (
		value.length > maxBase64UrlLength(maxDecodedBytes) ||
		!BASE64URL.test(value) ||
		value.length % 4 === 1
	) {
		throw new Error("invalid base64url");
	}
	return value;
}

function credentialIdToBase64(value: string): string {
	let bytes: Uint8Array;
	const uuid = UUID.exec(value);
	if (uuid) {
		bytes = hexToBytes(uuid.slice(1).join(""));
	} else if (value.startsWith("b64.")) {
		if (value.length > 4 + maxBase64UrlLength(MAX_CREDENTIAL_ID_BYTES)) {
			throw new Error("credential id outside supported bounds");
		}
		const encoded = value.slice(4);
		bytes = base64UrlToBytes(strictBase64Url(encoded, MAX_CREDENTIAL_ID_BYTES));
	} else {
		throw new Error("unsupported credential id");
	}
	if (bytes.length === 0 || bytes.length > MAX_CREDENTIAL_ID_BYTES) {
		throw new Error("credential id outside supported bounds");
	}
	return bytesToBase64(bytes);
}

function userHandleToBase64(value: string): string {
	const bytes = base64UrlToBytes(strictBase64Url(value, MAX_USER_HANDLE_BYTES));
	if (bytes.length === 0 || bytes.length > MAX_USER_HANDLE_BYTES) {
		throw new Error("user handle outside supported bounds");
	}
	return bytesToBase64(bytes);
}

function pkcs8ToStandardBase64(value: string): string {
	return base64UrlToBase64(strictBase64Url(value, MAX_PKCS8_BYTES));
}

function parseDate(value: string | null | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function validRpId(value: string): boolean {
	if (value.length === 0 || value.length > MAX_RP_ID_LENGTH) return false;
	return value
		.split(".")
		.every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

async function importPasskeys(
	rawCredentials: unknown[] | null | undefined,
	loginName: string,
	parentCreatedAt: number | undefined,
	importedAt: number,
	context: ImportParserContext,
	warnings: string[],
): Promise<PasskeyCredential[] | undefined> {
	if (!rawCredentials?.length) return undefined;

	const imported: PasskeyCredential[] = [];
	for (const [index, raw] of rawCredentials.entries()) {
		const label = `"${loginName}" passkey ${index + 1}`;
		const parsed = passkeySchema.safeParse(raw);
		if (!parsed.success) {
			warnings.push(`${label} had an unexpected shape and was skipped.`);
			continue;
		}
		const credential = parsed.data;
		if (
			credential.keyType !== "public-key" ||
			credential.keyAlgorithm !== "ECDSA" ||
			credential.keyCurve !== "P-256"
		) {
			warnings.push(`${label} uses an unsupported key type, algorithm, or curve and was skipped.`);
			continue;
		}
		if (!validRpId(credential.rpId)) {
			warnings.push(`${label} has an invalid relying-party ID and was skipped.`);
			continue;
		}

		let credentialId: string;
		let userHandle: string;
		let pkcs8: string;
		try {
			credentialId = credentialIdToBase64(credential.credentialId);
			userHandle = userHandleToBase64(credential.userHandle);
			pkcs8 = pkcs8ToStandardBase64(credential.keyValue);
		} catch {
			warnings.push(`${label} has invalid credential encoding and was skipped.`);
			continue;
		}

		let key: Awaited<ReturnType<ImportParserContext["passkeyImportPkcs8"]>>;
		try {
			key = await context.passkeyImportPkcs8(pkcs8);
			if (!key.privateKey || !key.publicKeyCose) throw new Error("empty converted key");
		} catch {
			// Suppress foreign conversion errors so they cannot leak key bytes into the UI.
			warnings.push(`${label} has invalid private-key material and was skipped.`);
			continue;
		}

		const credentialCreatedAt = parseDate(credential.creationDate);
		imported.push({
			credentialId,
			rpId: credential.rpId,
			rpName: credential.rpName || undefined,
			userHandle,
			userName: credential.userName || undefined,
			userDisplayName: credential.userDisplayName || undefined,
			alg: COSE_ES256,
			publicKeyCose: key.publicKeyCose,
			privateKey: key.privateKey,
			signCount: 0,
			createdAt: credentialCreatedAt ?? parentCreatedAt ?? importedAt,
		});

		if (credential.counter != null && credential.counter !== "0") {
			warnings.push(`${label} had its signature counter reset to zero.`);
		}
		if (credentialCreatedAt === undefined) {
			warnings.push(`${label} had no valid creation date; a fallback date was used.`);
		}
	}

	return imported.length ? imported : undefined;
}

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
export async function parseBitwarden(
	raw: string | Uint8Array,
	context: ImportParserContext,
): Promise<ImportResult> {
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
	const importedAt = Date.now();

	for (const item of parsed.data.items) {
		const name = item.name ?? "";
		const notes = item.notes || undefined;
		const fields = mapFields(item.fields);
		const createdAt = parseDate(item.creationDate);

		if (item.type === 1) {
			const login = item.login ?? {};
			const passkeys = await importPasskeys(
				login.fido2Credentials,
				name,
				createdAt,
				importedAt,
				context,
				warnings,
			);
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
				createdAt,
				passkeys,
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
