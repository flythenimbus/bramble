// The envelope a mailbox message travels in (docs/mailbox-service.md, "Keys and identity"): the
// sender's roster signature, then the bytes the core sealed. The seal binds the mailbox, message id
// and sender as AAD; the signature proves which device sent it, so a revoked device that still
// holds the VEK cannot post as another. Client-only: the server never imports this, so unlike
// protocol.ts it may use the rest of core.

import { base64ToBytes, bytesToBase64 } from "../../util/bytes";
import { sha256Hex } from "./protocol";

const SIG_LEN = 64;
/** A version byte, a 12-byte nonce and a 16-byte tag: the shortest message the core seals. */
const MIN_SEALED = 1 + 12 + 16;
/** The core's refusals of the sealed bytes themselves (`core-rust/src/mailbox.rs`). */
const REFUSALS = ["mailbox open failed", "not a sealed mailbox message", "plaintext is not utf-8"];

/** What sealing and opening need from a host: its CryptoAdapter, plus its roster key. */
export interface MailboxCryptoPort {
	mailboxId(groupKeyB64: string): Promise<string>;
	mailboxSeal(groupKeyB64: string, aad: string, plaintext: string): Promise<string>;
	mailboxOpen(groupKeyB64: string, aad: string, sealedB64: string): Promise<string>;
	/** Ed25519 with this device's roster key; base64 signature out. */
	sign(message: string): Promise<string>;
	verify(sigKey: string, message: string, sigB64: string): Promise<boolean>;
}

export type MailboxOpenReason = "malformed" | "bad_signature" | "unopenable";

export class MailboxOpenError extends Error {
	readonly reason: MailboxOpenReason;
	constructor(reason: MailboxOpenReason) {
		super(`mailbox message ${reason}`);
		this.name = "MailboxOpenError";
		this.reason = reason;
	}
}

interface Addressed {
	mailboxId: string;
	messageId: string;
	sender: string;
}

export const messageAad = (r: Addressed): string =>
	["bramble-mailbox-aad/v1", r.mailboxId, r.messageId, r.sender].join("\n");

export const signedText = (r: {
	mailboxId: string;
	messageId: string;
	sealedSha256: string;
}): string => ["bramble-mailbox-sig/v1", r.mailboxId, r.messageId, r.sealedSha256].join("\n");

/** Seal `plaintext` and sign it: the body to post, signature (64 bytes) then sealed bytes. */
export async function sealMessage(
	port: MailboxCryptoPort,
	r: Addressed & { groupKeyB64: string; plaintext: string },
): Promise<Uint8Array> {
	const sealed = base64ToBytes(await port.mailboxSeal(r.groupKeyB64, messageAad(r), r.plaintext));
	const sig = base64ToBytes(
		await port.sign(signedText({ ...r, sealedSha256: await sha256Hex(sealed) })),
	);
	if (sig.length !== SIG_LEN) throw new Error("a roster signature is 64 bytes");
	const body = new Uint8Array(SIG_LEN + sealed.length);
	body.set(sig);
	body.set(sealed, SIG_LEN);
	return body;
}

/**
 * Check the sender's signature, then open: nothing is decrypted for a body it did not sign. Only
 * a fault in the message is a MailboxOpenError; anything else (a locked vault, a bridge timeout,
 * the wrong vault's key) is rethrown, so the caller retries instead of quarantining.
 */
export async function openMessage(
	port: MailboxCryptoPort,
	r: Addressed & { groupKeyB64: string; body: Uint8Array },
): Promise<string> {
	if (r.body.length < SIG_LEN + MIN_SEALED) throw new MailboxOpenError("malformed");
	const sig = r.body.subarray(0, SIG_LEN);
	const sealed = r.body.subarray(SIG_LEN);
	const text = signedText({ ...r, sealedSha256: await sha256Hex(sealed) });
	if (!(await port.verify(r.sender, text, bytesToBase64(sig)))) {
		throw new MailboxOpenError("bad_signature");
	}
	if ((await port.mailboxId(r.groupKeyB64)) !== r.mailboxId) {
		throw new Error("this vault's key does not derive this mailbox");
	}
	try {
		return await port.mailboxOpen(r.groupKeyB64, messageAad(r), bytesToBase64(sealed));
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (REFUSALS.some((refusal) => msg.includes(refusal))) throw new MailboxOpenError("unopenable");
		throw e;
	}
}
