// KeePassXC stores a passkey as ordinary entry attributes on its login, named KPEX_PASSKEY_*.
// This turns that set into one of our PasskeyCredential objects, for both KeePass paths: the
// XML export and the .kdbx, which reach us as the same RawField pairs.
//
// One converter, deliberately, and not just to avoid duplication. Import de-duplication hashes
// the whole entry including its passkeys, so if the XML and .kdbx paths produced even slightly
// different bytes for the same credential, importing both would store the same private key
// twice and neither copy would be recognisable as a duplicate of the other.
//
// KeePassXC usually picks Ed25519, so most of these are EdDSA rather than ES256. The algorithm
// comes back from the crypto core, which reads it off the key's own OID.
// See docs/passkey-import.md.

import type { PasskeyCredential } from "../hooks/useVault";
import {
	bareBase64UrlToBase64,
	type ConversionTally,
	MAX_CREDENTIAL_ID_BYTES,
	pemToStandardBase64,
	reject,
	rejectionReason,
	userHandleToBase64,
	validRpId,
} from "./passkey-fields";
import type { RawField } from "./shared";
import type { ImportParserContext } from "./types";

const PREFIX = "KPEX_PASSKEY_";
const CREDENTIAL_ID = `${PREFIX}CREDENTIAL_ID`;
const PRIVATE_KEY_PEM = `${PREFIX}PRIVATE_KEY_PEM`;
const RELYING_PARTY = `${PREFIX}RELYING_PARTY`;
const USERNAME = `${PREFIX}USERNAME`;
const USER_HANDLE = `${PREFIX}USER_HANDLE`;
// Older KeePassXC builds spelled the handle this way. Read as a fallback so a database written
// by one of them still imports; we have not seen one, so it is tolerance, not a known format.
const LEGACY_USER_HANDLE = `${PREFIX}GENERATED_USER_ID`;

/** True once an entry carries anything KeePassXC would have written for a passkey. */
export function hasKeepassPasskey(fields: RawField[]): boolean {
	return fields.some((f) => f.key.startsWith(PREFIX));
}

/** Split an entry's fields into the passkey attributes and everything else. */
export function partitionPasskeyFields(fields: RawField[]): {
	passkey: Map<string, string>;
	rest: RawField[];
} {
	const passkey = new Map<string, string>();
	const rest: RawField[] = [];
	for (const f of fields) {
		if (f.key.startsWith(PREFIX)) passkey.set(f.key, f.value);
		else rest.push(f);
	}
	return { passkey, rest };
}

function required(passkey: Map<string, string>, key: string, label: string): string {
	const value = passkey.get(key)?.trim();
	if (!value) reject(`has no ${label}`);
	return value;
}

export interface KeepassPasskeyOutcome {
	/** The converted credential, or null when this entry has none or conversion failed. */
	credential: PasskeyCredential | null;
	/** Fields to keep. The KPEX_* set is dropped on success and kept on failure. */
	fields: RawField[];
}

/**
 * Convert one entry's KeePassXC passkey attributes.
 *
 * On success the KPEX_* fields are dropped: keeping them would leave a second, plaintext copy
 * of the private key sitting in a custom field next to the real credential. On failure they are
 * kept exactly as they arrived, hidden flags and all, because a passkey we cannot read is still
 * the user's only copy and silently discarding it would be worse than showing it raw.
 */
export async function convertKeepassPasskey(
	fields: RawField[],
	entryName: string,
	importedAt: number,
	context: ImportParserContext,
	warnings: string[],
	tally: ConversionTally,
): Promise<KeepassPasskeyOutcome> {
	if (!hasKeepassPasskey(fields)) return { credential: null, fields };
	const { passkey, rest } = partitionPasskeyFields(fields);
	const label = `"${entryName}"`;

	const failed = (reason: string): KeepassPasskeyOutcome => {
		warnings.push(`The passkey on ${label} ${reason}, so it was kept as fields instead.`);
		tally.failed++;
		return { credential: null, fields };
	};

	let credentialId: string;
	let userHandle: string;
	let rpId: string;
	let pkcs8: string;
	try {
		credentialId = bareBase64UrlToBase64(
			required(passkey, CREDENTIAL_ID, "credential ID"),
			MAX_CREDENTIAL_ID_BYTES,
		);
		userHandle = userHandleToBase64(
			passkey.get(USER_HANDLE)?.trim() || required(passkey, LEGACY_USER_HANDLE, "user handle"),
		);
		rpId = required(passkey, RELYING_PARTY, "relying-party ID");
		if (!validRpId(rpId)) reject("has an invalid relying-party ID");
		pkcs8 = pemToStandardBase64(required(passkey, PRIVATE_KEY_PEM, "private key"));
	} catch (e) {
		const reason = rejectionReason(e);
		return failed(reason ?? "could not be read");
	}

	let material: Awaited<ReturnType<ImportParserContext["passkeyImportPkcs8"]>>;
	try {
		material = await context.passkeyImportPkcs8(pkcs8);
		if (!material.privateKey || !material.publicKeyCose) throw new Error("empty converted key");
	} catch {
		// Suppress the conversion error itself: it comes from the crypto core and could name
		// bytes of the key.
		tally.failed++;
		warnings.push(
			`The passkey on ${label} has key material we can't read, so it was kept as fields instead.`,
		);
		return { credential: null, fields };
	}

	tally.converted++;
	return {
		credential: {
			credentialId,
			rpId,
			userHandle,
			userName: passkey.get(USERNAME)?.trim() || undefined,
			// From the key's OID. KeePassXC prefers Ed25519, so this is usually -8, not -7.
			alg: material.alg,
			publicKeyCose: material.publicKeyCose,
			privateKey: material.privateKey,
			// Always zero: a counter that goes backwards across synced devices reads to a
			// relying party as a cloned authenticator.
			signCount: 0,
			// Deliberately the run's timestamp and not KeePassXC's: dedupe strips nested dates,
			// so this cannot make the same credential look new on a second import.
			createdAt: importedAt,
		},
		fields: rest,
	};
}
