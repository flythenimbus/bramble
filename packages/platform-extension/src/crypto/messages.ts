// The CRYPTO_* wire protocol: one home for the payloads the popup/background send
// to the WASM crypto in the offscreen. chrome.runtime delivers untyped objects, so
// each payload is validated with zod at the receiving seam (dispatchCrypto) instead
// of being destructured as `any`. Byte fields ride as base64 strings; magicVersion
// is the one exception (a number[] today — see crypto.ts). The popup is insulated by
// CryptoAdapter; this is the platform-internal contract behind it. Mirrors
// sync/messages.ts. See docs/cryptography.md.

import { z } from "zod";

// verifierPrefix() bytes; sent as a number[] over chrome.runtime (not base64).
const magicVersion = z.array(z.number());
const wrapped = { verifierB64: z.string(), wrapIvB64: z.string(), wrappedVekB64: z.string() };

const passwordSlot = z.object({
	password: z.string(),
	saltB64: z.string(),
	slotIdB64: z.string(),
	magicVersion,
});
export const CryptoWrapPasswordSlotSchema = passwordSlot;
export const CryptoVerifyPasswordSlotSchema = passwordSlot.extend({ verifierB64: z.string() });
export const CryptoUnwrapPasswordSlotSchema = passwordSlot.extend(wrapped);

const webauthnSlot = z.object({
	hmacSecretB64: z.string(),
	slotIdB64: z.string(),
	magicVersion,
});
export const CryptoWrapWebauthnSlotSchema = webauthnSlot;
export const CryptoVerifyWebauthnSlotSchema = webauthnSlot.extend({ verifierB64: z.string() });
export const CryptoUnwrapWebauthnSlotSchema = webauthnSlot.extend(wrapped);

export const CryptoUnlockWithVekSchema = z.object({ vekB64: z.string() });
export const CryptoEncryptSchema = z.object({ plaintextJson: z.string() });
export const CryptoDecryptSchema = z.object({
	ciphertext: z.string(),
	iv: z.string(),
	wrappedDek: z.string(),
	dekIv: z.string(),
});
export const CryptoEncryptOuterSchema = z.object({ plaintext: z.string() });
export const CryptoDecryptOuterSchema = z.object({ iv: z.string(), ciphertext: z.string() });
export const CryptoOpenKdbxSchema = z.object({
	fileB64: z.string(),
	password: z.string(),
	keyfileB64: z.string().optional(),
});

export type CryptoUnlockWithVek = z.infer<typeof CryptoUnlockWithVekSchema>;
export type CryptoWrapPasswordSlot = z.infer<typeof CryptoWrapPasswordSlotSchema>;
export type CryptoUnwrapPasswordSlot = z.infer<typeof CryptoUnwrapPasswordSlotSchema>;
export type CryptoVerifyPasswordSlot = z.infer<typeof CryptoVerifyPasswordSlotSchema>;
export type CryptoWrapWebauthnSlot = z.infer<typeof CryptoWrapWebauthnSlotSchema>;
export type CryptoUnwrapWebauthnSlot = z.infer<typeof CryptoUnwrapWebauthnSlotSchema>;
export type CryptoVerifyWebauthnSlot = z.infer<typeof CryptoVerifyWebauthnSlotSchema>;
export type CryptoEncrypt = z.infer<typeof CryptoEncryptSchema>;
export type CryptoDecrypt = z.infer<typeof CryptoDecryptSchema>;
export type CryptoEncryptOuter = z.infer<typeof CryptoEncryptOuterSchema>;
export type CryptoDecryptOuter = z.infer<typeof CryptoDecryptOuterSchema>;
export type CryptoOpenKdbx = z.infer<typeof CryptoOpenKdbxSchema>;
