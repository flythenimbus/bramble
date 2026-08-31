// Field validation shared by every foreign passkey source: Bitwarden JSON, KeePassXC
// (XML and .kdbx), and OS credential exchange. Extracted from bitwarden.ts when KeePassXC
// became the second caller; the rules were never Bitwarden-specific, only their home was.
//
// Two properties matter more than the individual checks. Every cap is applied BEFORE decoding,
// so a hostile export cannot make us allocate on its say-so. And no rejection ever carries a
// value: the reason names the field and what was wrong with it, never what it contained.
// See docs/passkey-import.md.

import { base64UrlToBase64, base64UrlToBytes, bytesToBase64 } from "../util/bytes";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const BASE64_STD = /^[A-Za-z0-9+/]+={0,2}$/;

export const MAX_CREDENTIAL_ID_BYTES = 1023;
// Bounds the bridge, nothing more: WebAuthn's 64-byte user.id cap binds the RP, not us (#40).
export const MAX_USER_HANDLE_BYTES = 1023;
export const MAX_RP_ID_LENGTH = 253;
// Cap bridge input at 1 KiB while allowing optional PKCS#8 metadata.
export const MAX_PKCS8_BYTES = 1024;
// PEM is the same key plus armor, newlines and base64 expansion. Generous, and applied to the
// raw string before any stripping, so armor cannot be used to smuggle in a huge payload.
const MAX_PEM_CHARS = 4096;

export function maxBase64UrlLength(decodedBytes: number): number {
	return Math.ceil((decodedBytes * 4) / 3);
}

/**
 * Rejections carry a reason so the warning can say WHICH field failed and WHY, instead of one
 * "invalid credential encoding" covering three conversions (github issue #40). The sentinel
 * marks the message as ours and therefore safe to show: anything else that escapes these
 * helpers is reported generically, so a foreign error can never put value bytes in the UI.
 */
const OURS = "\u0000";
export function reject(reason: string): never {
	throw new Error(OURS + reason);
}

/** The reason phrase for a rejection we raised, or null for anything unexpected. */
export function rejectionReason(e: unknown): string | null {
	const message = e instanceof Error ? e.message : "";
	return message.startsWith(OURS) ? message.slice(OURS.length) : null;
}

export function strictBase64Url(value: string, maxDecodedBytes: number): string {
	if (value.length === 0) reject("empty");
	if (value.length > maxBase64UrlLength(maxDecodedBytes)) {
		reject(`longer than the ${maxDecodedBytes}-byte maximum`);
	}
	// Canonical base64url: no padding, no + or /. Anything else is a format we don't read.
	if (!BASE64URL.test(value) || value.length % 4 === 1) reject("not valid unpadded base64url");
	return value;
}

/** A bare base64url blob (KeePassXC's shape) to the standard base64 we store. */
export function bareBase64UrlToBase64(value: string, maxDecodedBytes: number): string {
	const bytes = base64UrlToBytes(strictBase64Url(value, maxDecodedBytes));
	if (bytes.length === 0) reject("empty");
	if (bytes.length > maxDecodedBytes) reject(`longer than the ${maxDecodedBytes}-byte maximum`);
	return bytesToBase64(bytes);
}

export function userHandleToBase64(value: string): string {
	return bareBase64UrlToBase64(value, MAX_USER_HANDLE_BYTES);
}

export function pkcs8ToStandardBase64(value: string): string {
	return base64UrlToBase64(strictBase64Url(value, MAX_PKCS8_BYTES));
}

/**
 * A PKCS#8 PEM (KeePassXC's shape) to the standard base64 the crypto core takes.
 *
 * SEC1 armor gets its own rejection rather than a generic one: "EC PRIVATE KEY" is a real key
 * in the wrong container, and telling the user that is more use than "unreadable".
 */
export function pemToStandardBase64(value: string): string {
	if (value.length === 0) reject("empty");
	// Before stripping, so armor and whitespace count against the cap too.
	if (value.length > MAX_PEM_CHARS) reject(`longer than the ${MAX_PEM_CHARS}-character maximum`);
	if (value.includes("BEGIN EC PRIVATE KEY")) reject("in SEC1 form rather than PKCS#8");
	const begin = "-----BEGIN PRIVATE KEY-----";
	const end = "-----END PRIVATE KEY-----";
	const from = value.indexOf(begin);
	const to = value.indexOf(end);
	if (from === -1 || to === -1 || to < from) reject("not a PKCS#8 PEM private key");
	const body = value.slice(from + begin.length, to).replace(/\s+/g, "");
	if (body.length === 0) reject("empty");
	if (body.length > maxBase64UrlLength(MAX_PKCS8_BYTES)) {
		reject(`longer than the ${MAX_PKCS8_BYTES}-byte maximum`);
	}
	if (!BASE64_STD.test(body)) reject("not valid base64");
	return body;
}

export function validRpId(value: string): boolean {
	if (value.length === 0 || value.length > MAX_RP_ID_LENGTH) return false;
	return value
		.split(".")
		.every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

/** Conversion outcomes across a whole file, so a systemic failure can be named once. */
export interface ConversionTally {
	converted: number;
	failed: number;
}

/**
 * Every key failing is not a file full of corrupt passkeys, it is the converter not answering:
 * a stale WASM build, native bindings that were never regenerated, or a platform whose adapter
 * does not reach the core at all. Without this the per-key warnings blame the user's data for
 * a build problem, which is how issue #87 was first read.
 */
export function systemicFailureWarning(tally: ConversionTally, source: string): string | null {
	if (tally.failed === 0 || tally.converted > 0) return null;
	return `No passkey could be converted, which usually means the app's crypto module is out of date rather than a problem with your ${source}.`;
}
