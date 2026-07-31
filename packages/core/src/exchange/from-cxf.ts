// CXF -> EntryData, the inverse of to-cxf.ts.
//
// Async because an imported passkey's key material is converted by the Rust core, reached
// through the same ImportParserContext the file importers use. Everything else is a pure
// mapping.

import type { PasskeyImportResult } from "../adapters/crypto";
import type { EntryData, PasskeyCredential } from "../hooks/useVault";
import { asText, type RawField, summarize, toCustomFields } from "../import/shared";
import type { ImportParserContext, ImportResult } from "../import/types";
import { base64UrlToBase64 } from "../util/bytes";
import { cardBrand } from "../util/card";
import { buildTotpUri } from "../util/totp";
import { COSE_ES256 } from "../vault/passkey";

import {
	type CxfCredential,
	type CxfEditableField,
	type CxfItem,
	cxfCredentialSchema,
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
	tally: { converted: number; failed: number },
): Promise<PasskeyCredential[]> {
	const out: PasskeyCredential[] = [];
	for (const p of raw) {
		// The Rust core parses the key and rebuilds the COSE public half, so an imported
		// passkey is byte-identical in shape to a minted one. CXF is base64url, that API is
		// standard base64. A key it rejects costs one passkey, not the item.
		let material: PasskeyImportResult;
		try {
			material = await context.passkeyImportPkcs8(base64UrlToBase64(p.key));
		} catch {
			warnings.push(`A passkey on "${title}" uses a key type we can't read and was skipped.`);
			tally.failed++;
			continue;
		}
		tally.converted++;
		out.push({
			// Stored as STANDARD base64 throughout the app; CXF is base64url.
			credentialId: base64UrlToBase64(p.credentialId),
			rpId: p.rpId,
			userHandle: base64UrlToBase64(p.userHandle),
			userName: p.username || undefined,
			userDisplayName: p.userDisplayName || undefined,
			alg: COSE_ES256,
			publicKeyCose: material.publicKeyCose,
			// The raw scalar unpacked from the PKCS#8, which is what core-rust signs with.
			privateKey: material.privateKey,
			// CXF requires exporters to zero this, and a non-zero counter reads as a clone.
			signCount: 0,
			createdAt,
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
	tally: { converted: number; failed: number },
): Promise<EntryData | null> {
	const g = group(item.credentials ?? []);
	const name = item.title || item.subtitle || "Untitled";
	const notes = g.notes.join("\n\n") || undefined;
	const createdAt = item.creationAt !== undefined ? item.creationAt * 1000 : undefined;
	const updatedAt = item.modifiedAt !== undefined ? item.modifiedAt * 1000 : undefined;
	const stamps = {
		...(createdAt !== undefined ? { createdAt } : {}),
		...(updatedAt !== undefined ? { updatedAt } : {}),
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
		return {
			type: "login",
			name,
			notes,
			...stamps,
			urls: item.scope?.urls ?? [],
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
			...stamps,
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
			...stamps,
			// CXF carries no public key, and we only ever copy it out, so leave it empty.
			publicKey: "",
			privateKey: derToPem(g.ssh.privateKey),
			keyType: g.ssh.keyType || undefined,
			customFields: toCustomFields(g.fields),
		};
	}

	if (!notes && g.fields.length === 0) return null;
	return { type: "note", name, notes, ...stamps, customFields: toCustomFields(g.fields) };
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

	// Every key failing means the converter isn't answering (stale WASM, or native bindings that
	// were never regenerated), not that the sender's passkeys are corrupt.
	if (tally.failed > 0 && tally.converted === 0) {
		warnings.push(
			"No passkey could be converted, which usually means the app's crypto module is out of date rather than a problem with the transfer.",
		);
	}

	return summarize(imported, skipped, warnings);
}
