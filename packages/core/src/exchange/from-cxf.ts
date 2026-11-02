// CXF -> EntryData, the inverse of to-cxf.ts.
//
// Async because an imported passkey's key material is converted by the Rust core, reached
// through the same ImportParserContext the file importers use. Everything else is a pure
// mapping.

import type { PasskeyImportResult, PasskeyPrfSecrets } from "../adapters/crypto";
import type { EntryData, PasskeyCredential } from "../hooks/useVault";
import {
	bareBase64UrlToBase64,
	type ConversionTally,
	MAX_CREDENTIAL_ID_BYTES,
	pkcs8ToStandardBase64,
	prfSecretsFrom,
	reject,
	rejectionReason,
	strictBase64Url,
	systemicFailureWarning,
	userHandleToBase64,
	validRpId,
} from "../import/passkey-fields";
import { asText, type RawField, summarize, toCustomFields } from "../import/shared";
import type { ImportParserContext, ImportResult } from "../import/types";
import { base64UrlToBase64, base64UrlToBytes } from "../util/bytes";
import { cardBrand } from "../util/card";
import { buildTotpUri } from "../util/totp";
import { keptExtensions, MAX_PRF_SECRET_BYTES } from "../vault/passkey";
import { normalizeTags } from "../vault/tags";

import {
	type CxfCredential,
	type CxfEditableField,
	type CxfItem,
	cxfCredentialSchema,
	cxfHmacCredentialsSchema,
	cxfPayloadSchema,
	cxfUnknownCredentialSchema,
} from "./types";

const FORMAT_ERROR = "This doesn't look like a credential exchange payload.";

/** Credentials of one item, split by the types we model. */
interface Grouped {
	basicAuth?: Extract<CxfCredential, { type: "basic-auth" }>;
	totp?: Extract<CxfCredential, { type: "totp" }>;
	card?: Extract<CxfCredential, { type: "credit-card" }>;
	ssh?: Extract<CxfCredential, { type: "ssh-key" }>;
	passkeys: Extract<CxfCredential, { type: "passkey" }>[];
	notes: string[];
	fields: RawField[];
	unknownTypes: string[];
}

function value(f: CxfEditableField | undefined): string {
	return f?.value ?? "";
}

function hidden(f: CxfEditableField | undefined): boolean {
	return f?.fieldType === "concealed-string";
}

function group(credentials: readonly unknown[]): Grouped {
	const g: Grouped = { passkeys: [], notes: [], fields: [], unknownTypes: [] };
	for (const raw of credentials) {
		const known = cxfCredentialSchema.safeParse(raw);
		if (!known.success) {
			salvage(raw, g);
			continue;
		}
		const c = known.data;
		switch (c.type) {
			case "basic-auth":
				g.basicAuth ??= c;
				break;
			case "totp":
				g.totp ??= c;
				break;
			case "passkey":
				g.passkeys.push(c);
				break;
			case "credit-card":
				g.card ??= c;
				break;
			case "ssh-key":
				g.ssh ??= c;
				break;
			case "note": {
				const text = value(c.content);
				if (text) g.notes.push(text);
				break;
			}
			case "custom-fields":
				for (const f of c.fields ?? []) {
					g.fields.push({ key: f.label ?? "", value: value(f), hidden: hidden(f) });
				}
				break;
		}
	}
	return g;
}

/**
 * A credential we don't model, or one we do that arrived malformed. Keep whatever reads as
 * a string so the item still carries its data, and record the type so the user is told.
 */
function salvage(raw: unknown, g: Grouped): void {
	const other = cxfUnknownCredentialSchema.safeParse(raw);
	if (!other.success) return;
	g.unknownTypes.push(other.data.type);
	for (const [key, v] of Object.entries(other.data)) {
		if (key !== "type" && typeof v === "string") g.fields.push({ key, value: v });
	}
}

/**
 * Split a passkey's `fido2Extensions` into the PRF secrets we use and the members we keep verbatim
 * for a later export. `unusable` means an hmacCredentials was there but couldn't be kept.
 */
function passkeyExtensions(ext: Record<string, unknown> | undefined): {
	prf?: PasskeyPrfSecrets;
	rest?: Record<string, unknown>;
	unusable: boolean;
	badLargeBlob: boolean;
} {
	if (!ext) return { unusable: false, badLargeBlob: false };
	const { hmacCredentials, ...others } = ext;
	const { kept: rest, badLargeBlob } = keptExtensions(others);
	if (hmacCredentials === undefined) return { rest, unusable: false, badLargeBlob };
	const parsed = cxfHmacCredentialsSchema.safeParse(hmacCredentials);
	const algorithm = parsed.success ? (parsed.data.algorithm ?? "hmac-sha256") : "";
	let prf: PasskeyPrfSecrets | undefined;
	if (parsed.success && algorithm.toLowerCase() === "hmac-sha256") {
		try {
			const half = (v: string) => base64UrlToBytes(strictBase64Url(v, MAX_PRF_SECRET_BYTES));
			const { credWithUV, credWithoutUV } = parsed.data;
			prf = prfSecretsFrom(half(credWithUV), credWithoutUV ? half(credWithoutUV) : undefined);
		} catch {
			prf = undefined;
		}
	}
	return { prf, rest, unusable: !prf, badLargeBlob };
}

/** CXF ships PKCS#8 DER; our SSH entries hold PEM text, and that direction is a clean wrap. */
function derToPem(keyB64Url: string): string {
	const b64 = base64UrlToBase64(keyB64Url);
	const lines = b64.match(/.{1,64}/g) ?? [];
	return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

async function toPasskeys(
	raw: readonly Extract<CxfCredential, { type: "passkey" }>[],
	title: string,
	createdAt: number,
	warnings: string[],
	context: ImportParserContext,
	tally: ConversionTally,
): Promise<PasskeyCredential[]> {
	const out: PasskeyCredential[] = [];
	for (const p of raw) {
		// The same caps every file importer applies, before anything is decoded. Stored ids are
		// STANDARD base64 throughout the app; CXF is base64url.
		let ids: { credentialId: string; userHandle: string; key: string };
		try {
			if (!validRpId(p.rpId)) reject("has an invalid relying-party ID");
			ids = {
				credentialId: bareBase64UrlToBase64(p.credentialId, MAX_CREDENTIAL_ID_BYTES),
				userHandle: userHandleToBase64(p.userHandle),
				key: pkcs8ToStandardBase64(p.key),
			};
		} catch (e) {
			// Only our own reasons are shown: a decoder error could carry bytes of the key.
			warnings.push(
				`A passkey on "${title}" ${rejectionReason(e) ?? "couldn't be read"}, so it was skipped.`,
			);
			continue;
		}
		// The Rust core parses the key and rebuilds the COSE public half, so an imported
		// passkey is byte-identical in shape to a minted one. A key it rejects costs one
		// passkey, not the item.
		let material: PasskeyImportResult;
		try {
			material = await context.passkeyImportPkcs8(ids.key);
		} catch {
			warnings.push(`A passkey on "${title}" uses a key type we can't read and was skipped.`);
			tally.failed++;
			continue;
		}
		tally.converted++;
		const { prf, rest, unusable, badLargeBlob } = passkeyExtensions(p.fido2Extensions);
		if (unusable) {
			warnings.push(
				`A passkey on "${title}" had a PRF secret Bramble can't use, so it was left out. Signing in works, but a site that encrypted data with it can't decrypt that data.`,
			);
		}
		if (badLargeBlob) {
			warnings.push(
				`A passkey on "${title}" had a large blob Bramble can't use, so it was left out.`,
			);
		}
		out.push({
			credentialId: ids.credentialId,
			rpId: p.rpId,
			userHandle: ids.userHandle,
			userName: p.username || undefined,
			userDisplayName: p.userDisplayName || undefined,
			// From the key's OID, not assumed: CXF carries no algorithm, so this is the only
			// place the truth is available. Hardcoding -7 mislabelled an Ed25519 key.
			alg: material.alg,
			publicKeyCose: material.publicKeyCose,
			// The raw scalar unpacked from the PKCS#8, which is what core-rust signs with.
			privateKey: material.privateKey,
			// CXF requires exporters to zero this, and a non-zero counter reads as a clone.
			signCount: 0,
			createdAt,
			...(prf ? { prf } : {}),
			...(rest ? { fido2Extensions: rest } : {}),
		});
	}
	return out;
}

function totpUriOf(
	totp: Extract<CxfCredential, { type: "totp" }>,
	title: string,
	fields: RawField[],
	warnings: string[],
): string | undefined {
	try {
		return buildTotpUri({
			secret: totp.secret,
			issuer: totp.issuer,
			account: totp.username,
			digits: totp.digits,
			period: totp.period,
			algorithm: totp.algorithm,
		});
	} catch {
		fields.push({ key: "TOTP", value: totp.secret, hidden: true });
		warnings.push(`The one-time-code key on "${title}" wasn't readable; kept as a custom field.`);
		return undefined;
	}
}

async function entryFor(
	item: CxfItem,
	warnings: string[],
	context: ImportParserContext,
	tally: ConversionTally,
): Promise<EntryData | null> {
	const g = group(item.credentials ?? []);
	const name = item.title || item.subtitle || "Untitled";
	const notes = g.notes.join("\n\n") || undefined;
	const createdAt = item.creationAt !== undefined ? item.creationAt * 1000 : undefined;
	const updatedAt = item.modifiedAt !== undefined ? item.modifiedAt * 1000 : undefined;
	// Metadata every entry kind carries, spread into whichever branch below wins. Tags
	// ride here rather than per-branch so a new entry type can't quietly drop them.
	const tags = normalizeTags(item.tags);
	const common = {
		...(createdAt !== undefined ? { createdAt } : {}),
		...(updatedAt !== undefined ? { updatedAt } : {}),
		...(tags ? { tags } : {}),
	};

	for (const t of new Set(g.unknownTypes)) {
		warnings.push(`"${name}" holds a ${t} credential, which became custom fields.`);
	}

	if (g.basicAuth || g.totp || g.passkeys.length > 0) {
		const totp = g.totp ? totpUriOf(g.totp, name, g.fields, warnings) : undefined;
		const passkeys = await toPasskeys(
			g.passkeys,
			name,
			createdAt ?? Date.now(),
			warnings,
			context,
			tally,
		);
		const scoped = item.scope?.urls ?? [];
		return {
			type: "login",
			name,
			notes,
			...common,
			// No scope: the passkey's rpId is the site, as on a login we mint (newPasskeyLogin).
			urls: scoped.length ? scoped : [...new Set(g.passkeys.map((p) => `https://${p.rpId}`))],
			username: value(g.basicAuth?.username) || g.totp?.username || g.passkeys[0]?.username || "",
			password: value(g.basicAuth?.password),
			...(totp ? { totp } : {}),
			...(passkeys.length ? { passkeys } : {}),
			customFields: toCustomFields(g.fields),
		};
	}

	if (g.card) {
		const number = value(g.card.number);
		const expiry = value(g.card.expiryDate).split("-");
		if (value(g.card.pin)) g.fields.push({ key: "PIN", value: value(g.card.pin), hidden: true });
		return {
			type: "card",
			name,
			notes,
			...common,
			cardholderName: value(g.card.fullName),
			number,
			brand: value(g.card.cardType) || cardBrand(number),
			// CXF year-month is "YYYY-MM"; our fields are the bare parts.
			expMonth: expiry[1] ? String(Number(expiry[1])) : "",
			expYear: expiry[0] ?? "",
			cvv: value(g.card.verificationNumber),
			customFields: toCustomFields(g.fields),
		};
	}

	if (g.ssh) {
		if (g.ssh.keyComment) g.fields.push({ key: "Comment", value: g.ssh.keyComment });
		return {
			type: "ssh-key",
			name,
			notes,
			...common,
			// CXF carries no public key, and we only ever copy it out, so leave it empty.
			publicKey: "",
			privateKey: derToPem(g.ssh.privateKey),
			keyType: g.ssh.keyType || undefined,
			customFields: toCustomFields(g.fields),
		};
	}

	if (!notes && g.fields.length === 0) return null;
	return { type: "note", name, notes, ...common, customFields: toCustomFields(g.fields) };
}

/**
 * Parse a CXF payload (the JSON the OS hands us, or a CXF file) into vault entries.
 * Throws only when the input isn't CXF at all; per-item problems become warnings.
 */
export async function parseCxf(
	raw: string | Uint8Array,
	context: ImportParserContext,
): Promise<ImportResult> {
	let json: unknown;
	try {
		json = JSON.parse(asText(raw));
	} catch {
		throw new Error(FORMAT_ERROR);
	}
	const parsed = cxfPayloadSchema.safeParse(json);
	if (!parsed.success || !parsed.data.accounts) throw new Error(FORMAT_ERROR);

	const imported: EntryData[] = [];
	const warnings: string[] = [];
	const tally = { converted: 0, failed: 0 };
	let skipped = 0;

	for (const account of parsed.data.accounts) {
		for (const item of account.items ?? []) {
			const entry = await entryFor(item, warnings, context, tally);
			if (entry) imported.push(entry);
			else skipped++;
		}
	}

	const systemic = systemicFailureWarning(tally, "transfer");
	if (systemic) warnings.push(systemic);

	return summarize(imported, skipped, warnings);
}
