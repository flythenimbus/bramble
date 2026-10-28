import { describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "../../util/bytes";
import {
	type MailboxCryptoPort,
	MailboxOpenError,
	messageAad,
	openMessage,
	sealMessage,
	signedText,
} from "./envelope";
import { sha256Hex } from "./protocol";

const GROUP = "R1JPVVBHUk9VUEdST1VQR1JPVVBHUk9VUEdST1VQR1I=";
const MAILBOX = "M".repeat(43);

/**
 * A fake but honest port: seal is a reversible encoding that remembers its AAD and refuses a
 * mismatch, and sign/verify are real Ed25519 over WebCrypto.
 */
async function device() {
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const sigKey = bytesToBase64(
		new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
	);
	const enc = new TextEncoder();
	const port: MailboxCryptoPort = {
		mailboxId: async () => MAILBOX,
		mailboxSeal: vi.fn(async (_g: string, aad: string, plaintext: string) =>
			bytesToBase64(enc.encode(JSON.stringify({ aad, plaintext }))),
		),
		mailboxOpen: vi.fn(async (_g: string, aad: string, sealedB64: string) => {
			const opened = JSON.parse(atob(sealedB64)) as { aad: string; plaintext: string };
			if (opened.aad !== aad) throw new Error("mailbox open failed");
			return opened.plaintext;
		}),
		sign: vi.fn(async (message: string) =>
			bytesToBase64(
				new Uint8Array(
					await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, enc.encode(message)),
				),
			),
		),
		verify: async (key: string, message: string, sigB64: string) => {
			try {
				const pub = await crypto.subtle.importKey(
					"raw",
					Uint8Array.from(atob(key), (c) => c.charCodeAt(0)),
					{ name: "Ed25519" },
					false,
					["verify"],
				);
				return await crypto.subtle.verify(
					{ name: "Ed25519" },
					pub,
					Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0)),
					enc.encode(message),
				);
			} catch {
				return false;
			}
		},
	};
	return { port, sigKey };
}

const fields = (sender: string, messageId = "I".repeat(22)) => ({
	groupKeyB64: GROUP,
	mailboxId: MAILBOX,
	messageId,
	sender,
});

async function reason(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		if (e instanceof MailboxOpenError) return e.reason;
		throw e;
	}
	throw new Error("expected a MailboxOpenError");
}

describe("message envelope", () => {
	it("round-trips a message and lays the body out as signature then sealed bytes", async () => {
		const { port, sigKey } = await device();
		const body = await sealMessage(port, { ...fields(sigKey), plaintext: "hello" });
		const sealedB64 = await (port.mailboxSeal as ReturnType<typeof vi.fn>).mock.results[0]?.value;
		expect(body.length).toBe(64 + atob(sealedB64).length);
		expect(await openMessage(port, { ...fields(sigKey), body })).toBe("hello");
	});

	it("binds the AAD to mailbox, message id and sender, in that canonical form", () => {
		expect(messageAad({ mailboxId: "M", messageId: "I", sender: "S" })).toBe(
			"bramble-mailbox-aad/v1\nM\nI\nS",
		);
		expect(signedText({ mailboxId: "M", messageId: "I", sealedSha256: "ab" })).toBe(
			"bramble-mailbox-sig/v1\nM\nI\nab",
		);
	});

	it("signs the mailbox, the message id and the sealed bytes' hash", async () => {
		const { port, sigKey } = await device();
		const body = await sealMessage(port, { ...fields(sigKey), plaintext: "hello" });
		const sealedSha256 = await sha256Hex(body.subarray(64));
		expect(port.sign).toHaveBeenCalledWith(
			signedText({ mailboxId: MAILBOX, messageId: "I".repeat(22), sealedSha256 }),
		);
	});

	it("refuses a body claimed by another sender as bad_signature", async () => {
		const a = await device();
		const b = await device();
		const body = await sealMessage(a.port, { ...fields(a.sigKey), plaintext: "hello" });
		expect(await reason(openMessage(b.port, { ...fields(b.sigKey), body }))).toBe("bad_signature");
	});

	it("refuses a body moved to another message id", async () => {
		const { port, sigKey } = await device();
		const body = await sealMessage(port, { ...fields(sigKey), plaintext: "hello" });
		const moved = openMessage(port, { ...fields(sigKey, "Y".repeat(22)), body });
		expect(await reason(moved)).toBe("bad_signature");
	});

	it("refuses a short body as malformed without calling the port", async () => {
		const { port, sigKey } = await device();
		const short = new Uint8Array(64 + 12);
		expect(await reason(openMessage(port, { ...fields(sigKey), body: short }))).toBe("malformed");
		expect(port.mailboxOpen).not.toHaveBeenCalled();
	});

	it("refuses sealed bytes that do not open as unopenable", async () => {
		const { port, sigKey } = await device();
		const garbage = new TextEncoder().encode(JSON.stringify({ aad: "wrong", plaintext: "x" }));
		const messageId = "I".repeat(22);
		const sig = await port.sign(
			signedText({ mailboxId: MAILBOX, messageId, sealedSha256: await sha256Hex(garbage) }),
		);
		const body = new Uint8Array([
			...Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)),
			...garbage,
		]);
		expect(await reason(openMessage(port, { ...fields(sigKey, messageId), body }))).toBe(
			"unopenable",
		);
	});
});
