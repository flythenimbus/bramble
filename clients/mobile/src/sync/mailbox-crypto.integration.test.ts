import { existsSync, readFileSync } from "node:fs";
import type { CryptoAdapter } from "@core/adapters/crypto";
import { buildCryptoAdapter } from "@core/adapters/crypto-wasm";
import {
	type MailboxCryptoPort,
	MailboxOpenError,
	openMessage,
	sealMessage,
} from "@core/sync/mailbox/envelope";
import { MAILBOX_ID_RE } from "@core/sync/mailbox/protocol";
import type { VaultCrypto } from "@core/wasm";
import { beforeAll, describe, expect, it } from "vitest";

// The mailbox envelope over the real core: HKDF and AES-GCM in the wasm, real roster keys signing
// and verifying. Two devices of one vault share the VEK and hold their own roster keys.

const WASM_DIR = `${process.cwd()}/../extension/public/wasm`;

interface RosterWasm {
	roster_sig_generate_key(): { secretKey: string; publicKey: string };
	roster_sign(secretB64: string, message: string): string;
	roster_verify(publicB64: string, message: string, sigB64: string): boolean;
}

let wasm: VaultCrypto & RosterWasm;
let crypto: CryptoAdapter;

beforeAll(async () => {
	if (!existsSync(`${WASM_DIR}/vault_crypto.js`))
		throw new Error(`no WASM at ${WASM_DIR} (gitignored artifact): run \`pnpm run wasm:build\``);
	const mod = await import(`${WASM_DIR}/vault_crypto.js`);
	await mod.default({ module_or_path: readFileSync(`${WASM_DIR}/vault_crypto_bg.wasm`) });
	wasm = mod as unknown as VaultCrypto & RosterWasm;
	crypto = buildCryptoAdapter(async () => wasm);
}, 30_000);

const GROUP = Buffer.alloc(32, 9).toString("base64");

function port(secretKey: string): MailboxCryptoPort {
	return {
		mailboxId: (g) => crypto.mailboxId!(g),
		mailboxSeal: (g, aad, plaintext) => crypto.mailboxSeal!(g, aad, plaintext),
		mailboxOpen: (g, aad, sealed) => crypto.mailboxOpen!(g, aad, sealed),
		sign: async (message) => wasm.roster_sign(secretKey, message),
		verify: async (key, message, sig) => wasm.roster_verify(key, message, sig),
	};
}

describe("mailbox envelope over the real core", () => {
	it("seals with one device's roster key and opens on another of the same vault", async () => {
		const vek = await crypto.generateVek();
		const sender = wasm.roster_sig_generate_key();
		const receiver = wasm.roster_sig_generate_key();
		const mailboxId = await crypto.mailboxId!(GROUP);
		expect(MAILBOX_ID_RE.test(mailboxId)).toBe(true);
		const r = {
			groupKeyB64: GROUP,
			mailboxId,
			messageId: "A".repeat(22),
			sender: sender.publicKey,
		};
		const body = await sealMessage(port(sender.secretKey), { ...r, plaintext: '{"kind":"delta"}' });
		await crypto.unlockWithVek(vek);
		expect(await openMessage(port(receiver.secretKey), { ...r, body })).toBe('{"kind":"delta"}');
	});

	it("refuses the same body under a different vault key", async () => {
		await crypto.generateVek();
		const sender = wasm.roster_sig_generate_key();
		const mailboxId = await crypto.mailboxId!(GROUP);
		const r = {
			groupKeyB64: GROUP,
			mailboxId,
			messageId: "B".repeat(22),
			sender: sender.publicKey,
		};
		const body = await sealMessage(port(sender.secretKey), { ...r, plaintext: "x" });
		await crypto.generateVek();
		const opening = openMessage(port(sender.secretKey), { ...r, body });
		await expect(opening).rejects.toBeInstanceOf(MailboxOpenError);
		await expect(opening).rejects.toMatchObject({ reason: "unopenable" });
	});
});
