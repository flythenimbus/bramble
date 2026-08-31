// EntryData -> CXF, the inverse of from-cxf.ts.
//
// Emitted as plain JSON that Apple's ASExportedCredentialData decodes verbatim, so there is
// no Swift mapping layer. Every `Data` field on the wire is base64url UNPADDED, while our
// passkey fields are stored as STANDARD base64 (see webauthn-proxy.ts), hence the conversion
// at every passkey boundary below.

import type { CardEntryData, Entry, LoginEntryData, PasskeyCredential } from "../hooks/useVault";
import { base64ToBase64Url, bytesToBase64Url } from "../util/bytes";
import { parseTotp } from "../util/totp";
import { COSE_ES256 } from "../vault/passkey";
import { pkcs8FromScalar } from "./passkey-key";
import {
	CXF_VERSION,
	type CxfCredential,
	type CxfEditableField,
	type CxfItem,
	type CxfPayload,
} from "./types";

export interface CxfExportOptions {
	/** Our bundle/extension id, echoed to the importer so it can name the source. */
	exporterRpId: string;
	exporterDisplayName: string;
	/** Epoch ms; injected so tests don't depend on the clock. */
	now: number;
}

export interface CxfExportResult {
	payload: CxfPayload;
	/** Lossy mappings, surfaced the same way the importers surface theirs. */
	warnings: string[];
}

const encoder = new TextEncoder();

/** CXF ids are opaque b64url bytes, so our entry ids go out as their own UTF-8 bytes. */
function idOf(text: string): string {
	return bytesToBase64Url(encoder.encode(text));
}

function field(value: string | undefined, concealed = false): CxfEditableField | undefined {
	if (!value) return undefined;
	return { fieldType: concealed ? "concealed-string" : "string", value };
}

/** Epoch ms -> UNIX seconds, which is what CXF timestamps are. */
function seconds(ms: number | undefined): number | undefined {
	return ms === undefined ? undefined : Math.floor(ms / 1000);
}

/**
 * Absolute URLs only: the importer decodes these into Foundation.URL and drops what it
 * can't parse. A bare host (which our schema allows) is promoted to https rather than lost.
 */
function toUrls(urls: readonly string[]): string[] {
	const out: string[] = [];
	for (const raw of urls) {
		const u = raw.trim();
		if (!u) continue;
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) out.push(u);
		else out.push(`https://${u}`);
	}
	return out;
}

/** Null when the stored key isn't a P-256 scalar we can express as PKCS#8. */
function passkeyCredential(p: PasskeyCredential): CxfCredential | null {
	// pkcs8FromScalar wraps ANY 32 bytes in a P-256 PKCS#8 prefix, and an Ed25519 seed is also
	// 32 bytes, so without this gate an imported EdDSA passkey would export as a corrupt P-256
	// key that decodes fine and then verifies against nothing. Skipping is warned about upstream.
	if (p.alg !== COSE_ES256) return null;
	// CXF's `key` is PKCS#8 DER; we store the bare 32-byte scalar. Sending the scalar as-is
	// decodes cleanly on the far side and then fails when the importer tries to USE it, which
	// is what "contains unsupported data" looks like from the user's end.
	const key = pkcs8FromScalar(p.privateKey);
	if (!key) return null;
	return {
		type: "passkey",
		credentialId: base64ToBase64Url(p.credentialId),
		rpId: p.rpId,
		// Required by CXF where ours are optional; an empty string is the honest default.
		username: p.userName ?? "",
		userDisplayName: p.userDisplayName ?? p.userName ?? "",
		userHandle: base64ToBase64Url(p.userHandle),
		key,
	};
}

/** Structured TOTP, or null when the stored key isn't one we can parse (HOTP, garbage). */
function totpCredential(stored: string): CxfCredential | null {
	const parsed = parseTotp(stored);
	if (!parsed) return null;
	const { totp, issuer, account } = parsed;
	return {
		type: "totp",
		secret: totp.secret.base32,
		period: totp.period,
		digits: totp.digits,
		algorithm: totp.algorithm.toLowerCase() as "sha1" | "sha256" | "sha512",
		...(account ? { username: account } : {}),
		...(issuer ? { issuer } : {}),
	};
}

function customFieldsCredential(
	pairs: readonly { key: string; value: string; hidden?: boolean }[],
): CxfCredential | null {
	const fields: CxfEditableField[] = [];
	for (const { key, value, hidden } of pairs) {
		if (!key || !value) continue;
		fields.push({ fieldType: hidden ? "concealed-string" : "string", value, label: key });
	}
	return fields.length ? { type: "custom-fields", fields } : null;
}

function loginCredentials(e: LoginEntryData, warnings: string[]): CxfCredential[] {
	const out: CxfCredential[] = [];
	const extra = [...(e.customFields ?? [])];

	if (e.username || e.password) {
		out.push({
			type: "basic-auth",
			...(field(e.username) ? { username: field(e.username) } : {}),
			...(field(e.password, true) ? { password: field(e.password, true) } : {}),
		});
	}
	if (e.totp) {
		const totp = totpCredential(e.totp);
		if (totp) out.push(totp);
		else {
			// Keep the bytes rather than drop them; a one-off key shape is still the user's data.
			extra.push({ key: "TOTP", value: e.totp, hidden: true });
			warnings.push(
				`"${e.name}" has a one-time-code key we couldn't read; sent as a custom field.`,
			);
		}
	}
	for (const p of e.passkeys ?? []) {
		const credential = passkeyCredential(p);
		if (credential) out.push(credential);
		else warnings.push(`A passkey on "${e.name}" uses a key we can't export and was left behind.`);
	}
	return [...out, ...customFieldsOrNothing(extra)];
}

function customFieldsOrNothing(
	pairs: readonly { key: string; value: string; hidden?: boolean }[],
): CxfCredential[] {
	const c = customFieldsCredential(pairs);
	return c ? [c] : [];
}

function cardCredential(e: CardEntryData): CxfCredential {
	const expiry =
		e.expMonth && e.expYear ? `${e.expYear}-${e.expMonth.padStart(2, "0")}` : undefined;
	return {
		type: "credit-card",
		...(field(e.number, true) ? { number: field(e.number, true) } : {}),
		...(field(e.cardholderName) ? { fullName: field(e.cardholderName) } : {}),
		...(field(e.brand) ? { cardType: field(e.brand) } : {}),
		...(field(e.cvv, true) ? { verificationNumber: field(e.cvv, true) } : {}),
		...(expiry ? { expiryDate: { fieldType: "year-month" as const, value: expiry } } : {}),
	};
}

function credentialsFor(e: Entry, warnings: string[]): CxfCredential[] {
	if (e.type === "login") return loginCredentials(e, warnings);

	const extra = [...(e.customFields ?? [])];
	if (e.type === "card") return [cardCredential(e), ...customFieldsOrNothing(extra)];
	if (e.type === "ssh-key") {
		// CXF's SSHKey wants PKCS#8 DER; we store PEM in whichever flavour the user pasted
		// (OpenSSH, PKCS#1, SEC1). Converting an OpenSSH container is real work for a type no
		// counterparty is known to consume, so the key travels verbatim as custom fields.
		// The reverse direction DOES build a real ssh-key entry; see from-cxf.ts.
		warnings.push(`"${e.name}" is an SSH key, which travels as custom fields.`);
		return customFieldsOrNothing([
			{ key: "Key Type", value: e.keyType ?? "" },
			{ key: "Public Key", value: e.publicKey },
			{ key: "Private Key", value: e.privateKey, hidden: true },
			{ key: "Passphrase", value: e.passphrase ?? "", hidden: true },
			...extra,
		]);
	}
	return customFieldsOrNothing(extra);
}

function itemFor(e: Entry, warnings: string[]): CxfItem {
	const credentials = credentialsFor(e, warnings);
	if (e.notes) credentials.push({ type: "note", content: { fieldType: "string", value: e.notes } });
	// CXF items carry at least one credential, and an empty note is better than a dropped entry.
	if (credentials.length === 0) {
		credentials.push({ type: "note", content: { fieldType: "string", value: "" } });
	}
	const urls = e.type === "login" ? toUrls(e.urls) : [];
	return {
		id: idOf(e.id),
		title: e.name,
		...(seconds(e.createdAt) !== undefined ? { creationAt: seconds(e.createdAt) } : {}),
		...(seconds(e.updatedAt) !== undefined ? { modifiedAt: seconds(e.updatedAt) } : {}),
		...(urls.length ? { scope: { urls, androidApps: [] } } : {}),
		// CXF has carried a `tags` field all along (see cxfItemSchema); we simply never
		// had tags to put in it.
		...(e.tags?.length ? { tags: e.tags } : {}),
		credentials,
	};
}

/**
 * Map decrypted vault entries to a CXF payload. Needs an unlocked vault: everything here
 * is plaintext by definition, which is why the caller gates on an explicit confirmation.
 */
export function toCxf(entries: readonly Entry[], opts: CxfExportOptions): CxfExportResult {
	const warnings: string[] = [];
	const items = entries.map((e) => itemFor(e, warnings));
	return {
		payload: {
			version: { ...CXF_VERSION },
			exporterRpId: opts.exporterRpId,
			exporterDisplayName: opts.exporterDisplayName,
			timestamp: Math.floor(opts.now / 1000),
			accounts: [
				{
					id: idOf(opts.exporterRpId),
					// We have no account identity to disclose: the vault is local and unnamed.
					username: "",
					email: "",
					collections: [],
					items,
				},
			],
		},
		warnings,
	};
}
