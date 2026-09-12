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

// Per-vault VEK: the USE-VEK ops receive the target vault's key here. The BACKGROUND injects
// it (from the vek store) into the message on its way to the offscreen; views never send it.
// See docs/multiple-vaults.md "Per-vault VEK".
const vekInject = { vekB64: z.string().optional() };

const passwordSlot = z.object({
	password: z.string(),
	saltB64: z.string(),
	slotIdB64: z.string(),
	magicVersion,
});
export const CryptoWrapPasswordSlotSchema = passwordSlot.extend(vekInject);
export const CryptoVerifyPasswordSlotSchema = passwordSlot.extend({ verifierB64: z.string() });
export const CryptoUnwrapPasswordSlotSchema = passwordSlot.extend(wrapped);

const webauthnSlot = z.object({
	hmacSecretB64: z.string(),
	slotIdB64: z.string(),
	magicVersion,
});
export const CryptoWrapWebauthnSlotSchema = webauthnSlot.extend(vekInject);
export const CryptoVerifyWebauthnSlotSchema = webauthnSlot.extend({ verifierB64: z.string() });
export const CryptoUnwrapWebauthnSlotSchema = webauthnSlot.extend(wrapped);

export const CryptoUnlockWithVekSchema = z.object({ vekB64: z.string() });
export const CryptoEncryptSchema = z.object({ plaintextJson: z.string(), ...vekInject });
export const CryptoDecryptSchema = z.object({
	ciphertext: z.string(),
	iv: z.string(),
	wrappedDek: z.string(),
	dekIv: z.string(),
	...vekInject,
});
export const CryptoDecryptBatchSchema = z.object({
	entries: z.array(
		z.object({
			ciphertext: z.string(),
			iv: z.string(),
			wrappedDek: z.string(),
			dekIv: z.string(),
		}),
	),
	...vekInject,
});
// Autofill may skip undecryptable entries, unlike the strict crypto adapter batch.
export const CryptoDecryptIndexSchema = z.object({
	entries: z.array(CryptoDecryptSchema.omit({ vekB64: true }).extend({ id: z.string() })),
	...vekInject,
});
export const CryptoDecryptIndexResultSchema = z.array(
	z.object({ id: z.string(), plaintext: z.string().nullable() }),
);
export const CryptoEncryptOuterSchema = z.object({ plaintext: z.string(), ...vekInject });
export const CryptoDecryptOuterSchema = z.object({
	iv: z.string(),
	ciphertext: z.string(),
	...vekInject,
});
export const CryptoOpenKdbxSchema = z.object({
	fileB64: z.string(),
	password: z.string(),
	keyfileB64: z.string().optional(),
});

// KDBX4 export. Carries the entries as KeePass String pairs already shaped by the core
// mapper, plus the user's chosen file password; the reply is the .kdbx as base64.
export const CryptoSaveKdbxSchema = z.object({
	entries: z.array(
		z.object({
			strings: z.array(z.object({ key: z.string(), value: z.string(), protected: z.boolean() })),
		}),
	),
	password: z.string(),
});

// Portable vault (.bramble export/import). No VEK field: the core seals under a key it
// generates per file, so these never touch the session key and carry no vaultId.
const portableVaultBlob = z.object({
	slotId: z.string(),
	salt: z.string(),
	verifier: z.string(),
	wrapIv: z.string(),
	wrappedVek: z.string(),
	entriesIv: z.string(),
	entriesCiphertext: z.string(),
});

export const CryptoSealPortableVaultSchema = z.object({
	entriesJson: z.string(),
	password: z.string(),
	magicVersion,
});

export const CryptoOpenPortableVaultSchema = z.object({
	password: z.string(),
	file: portableVaultBlob,
	magicVersion,
});

// Passkey provider (authenticator role). The crypto is pure, so no slot/VEK fields.
export const CryptoPasskeyMakeSchema = z.object({
	rpId: z.string(),
	userVerified: z.boolean(),
});
export const CryptoPasskeyGetSchema = z.object({
	rpId: z.string(),
	privateKeyB64: z.string(),
	// Required, not defaulted: a missing alg must fail the parse rather than quietly sign
	// with the wrong primitive.
	alg: z.number().int(),
	clientDataHashB64: z.string(),
	userVerified: z.boolean(),
});
export const CryptoPasskeyImportPkcs8Schema = z.object({
	pkcs8B64: z.string(),
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
export type CryptoDecryptBatch = z.infer<typeof CryptoDecryptBatchSchema>;
export type CryptoEncryptOuter = z.infer<typeof CryptoEncryptOuterSchema>;
export type CryptoDecryptOuter = z.infer<typeof CryptoDecryptOuterSchema>;
export type CryptoPasskeyMake = z.infer<typeof CryptoPasskeyMakeSchema>;
export type CryptoPasskeyGet = z.infer<typeof CryptoPasskeyGetSchema>;
export type CryptoPasskeyImportPkcs8 = z.infer<typeof CryptoPasskeyImportPkcs8Schema>;
