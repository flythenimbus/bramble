// A Proton Pass passkey is an opaque `content` blob on its login: base64 of MessagePack
// `{c, v}`, where `c` is Proton's own ProtonPassKey record holding a COSE key. We take the P-256
// scalar out of that key and send it through the same PKCS#8 import every other source uses.
// See docs/passkey-import.md.

import { z } from "zod";
import { pkcs8FromScalar } from "../exchange/passkey-key";
import type { PasskeyCredential } from "../hooks/useVault";
import { base64ToBytes, base64UrlToBase64, bytesToBase64 } from "../util/bytes";
import { decodeMsgpack, type MsgpackValue } from "../util/msgpack";
import {
	type ConversionTally,
	MAX_CREDENTIAL_ID_BYTES,
	MAX_USER_HANDLE_BYTES,
	reject,
	rejectionReason,
	validRpId,
} from "./passkey-fields";
import type { ImportParserContext } from "./types";

const passkeySchema = z.object({
	content: z.string(),
	rpName: z.string().nullish(),
	userName: z.string().nullish(),
	userDisplayName: z.string().nullish(),
	createTime: z.number().nullish(),
});

// A real one is under 1 KiB; checked before decoding.
const MAX_CONTENT_CHARS = 8192;
const P256_SCALAR_BYTES = 32;
const COSE_CRV = -1;
const COSE_D = -4;
const COSE_CRV_P256 = 1;

const get = (v: MsgpackValue | undefined, key: string) =>
	v instanceof Map ? v.get(key) : undefined;

/** Proton's serde enums are `{t, c}`, e.g. `{t: "assign", c: "EC2"}`. */
const tagged = (v: MsgpackValue | undefined, t: string) =>
	get(v, "t") === t ? get(v, "c") : undefined;

const isByte = (b: MsgpackValue) =>
	typeof b === "number" && Number.isInteger(b) && b >= 0 && b <= 255;

/** rmp_serde writes a Vec<u8> as an array of ints; accept bin too. */
function bytesOf(v: MsgpackValue | undefined): Uint8Array | null {
	if (v instanceof Uint8Array) return v;
	if (!Array.isArray(v) || !v.every(isByte)) return null;
	return Uint8Array.from(v as number[]);
}

/** Proton's ProtonInteger: an i128 as little-endian bytes. Only small non-negative ones matter. */
function protonInt(v: MsgpackValue | undefined): number | null {
	const b = bytesOf(get(v, "inner"));
	if (!b || b.length > 16) return null;
	let n = 0;
	for (let i = b.length - 1; i >= 0; i--) n = n * 256 + (b[i] ?? 0);
	return Number.isSafeInteger(n) ? n : null;
}

function p256Scalar(key: MsgpackValue | undefined): Uint8Array {
	const alg = get(key, "alg");
	if (
		tagged(get(key, "kty"), "assign") !== "EC2" ||
		(alg != null && tagged(alg, "assign") !== "ES256")
	) {
		reject("uses a key type other than P-256");
	}
	const params = get(key, "par");
	let crv: number | null = null;
	let d: Uint8Array | null = null;
	for (const pair of Array.isArray(params) ? params : []) {
		if (!Array.isArray(pair)) continue;
		const label = tagged(pair[0], "int");
		if (label === COSE_CRV) crv = protonInt(tagged(pair[1], "int"));
		if (label === COSE_D) d = bytesOf(tagged(pair[1], "bytes"));
	}
	if (crv !== COSE_CRV_P256) reject("uses a key type other than P-256");
	if (d?.length !== P256_SCALAR_BYTES) reject("has no private key");
	return d;
}

function requiredBytes(v: MsgpackValue | undefined, field: string, max: number): Uint8Array {
	const b = bytesOf(v);
	if (!b?.length) reject(`has no ${field}`);
	if (b.length > max) reject(`has a ${field} longer than the ${max}-byte maximum`);
	return b;
}

function readRecord(content: string): MsgpackValue {
	if (content.length > MAX_CONTENT_CHARS) reject("is larger than any Proton Pass passkey");
	const outer = decodeMsgpack(base64ToBytes(content));
	if (!(outer instanceof Map)) reject("couldn't be read");
	if (outer.get("v") !== 1) reject("is in a newer Proton Pass format we can't read yet");
	return decodeMsgpack(bytesOf(get(outer, "c")) ?? reject("couldn't be read"));
}

const text = (v: MsgpackValue | undefined) => (typeof v === "string" && v ? v : undefined);

export async function importProtonPasskeys(
	rawPasskeys: unknown[] | null | undefined,
	loginName: string,
	parentCreatedAt: number | undefined,
	importedAt: number,
	context: ImportParserContext,
	warnings: string[],
	tally: ConversionTally,
): Promise<PasskeyCredential[] | undefined> {
	if (!rawPasskeys?.length) return undefined;

	const imported: PasskeyCredential[] = [];
	for (const [index, raw] of rawPasskeys.entries()) {
		const label = `"${loginName}" passkey ${index + 1}`;
		const parsed = passkeySchema.safeParse(raw);
		if (!parsed.success) {
			warnings.push(`${label} had an unexpected shape and was skipped.`);
			continue;
		}
		const passkey = parsed.data;

		let record: MsgpackValue;
		let fields: {
			credentialId: Uint8Array;
			rpId: string;
			userHandle: Uint8Array;
			scalar: Uint8Array;
		};
		try {
			record = readRecord(passkey.content);
			const rpId = get(record, "rid");
			if (typeof rpId !== "string" || !validRpId(rpId)) reject("has an invalid relying-party ID");
			fields = {
				credentialId: requiredBytes(get(record, "cid"), "credential ID", MAX_CREDENTIAL_ID_BYTES),
				rpId,
				userHandle: requiredBytes(get(record, "uhd"), "user handle", MAX_USER_HANDLE_BYTES),
				scalar: p256Scalar(get(record, "key")),
			};
		} catch (e) {
			// Only our own reasons are shown: a decoder error could carry bytes of the key.
			warnings.push(`${label} ${rejectionReason(e) ?? "couldn't be read"}, so it was skipped.`);
			continue;
		}

		let key: Awaited<ReturnType<ImportParserContext["passkeyImportPkcs8"]>>;
		try {
			const pkcs8 = pkcs8FromScalar(bytesToBase64(fields.scalar));
			if (!pkcs8) throw new Error("not a P-256 scalar");
			key = await context.passkeyImportPkcs8(base64UrlToBase64(pkcs8));
			if (!key.privateKey || !key.publicKeyCose) throw new Error("empty converted key");
		} catch {
			warnings.push(`${label} has invalid private-key material and was skipped.`);
			tally.failed++;
			continue;
		}

		const ownCreatedAt =
			passkey.createTime != null && passkey.createTime > 0 ? passkey.createTime * 1000 : undefined;
		tally.converted++;
		imported.push({
			credentialId: bytesToBase64(fields.credentialId),
			rpId: fields.rpId,
			rpName: passkey.rpName || undefined,
			userHandle: bytesToBase64(fields.userHandle),
			userName: passkey.userName || text(get(record, "un")),
			userDisplayName: passkey.userDisplayName || text(get(record, "udn")),
			alg: key.alg,
			publicKeyCose: key.publicKeyCose,
			privateKey: key.privateKey,
			// A counter that goes backwards across synced devices reads as a cloned authenticator.
			signCount: 0,
			createdAt: ownCreatedAt ?? parentCreatedAt ?? importedAt,
		});

		const counter = get(record, "cnt");
		if (typeof counter === "number" && counter !== 0) {
			warnings.push(`${label} had its signature counter reset to zero.`);
		}
		if (get(get(record, "ext"), "hmac_secret") != null) {
			warnings.push(
				`${label} had a PRF secret, which Bramble can't keep. Signing in works, but a site that encrypted data with it can't decrypt that data.`,
			);
		}
		if (ownCreatedAt === undefined) {
			warnings.push(`${label} had no valid creation date; a fallback date was used.`);
		}
	}

	return imported.length ? imported : undefined;
}
