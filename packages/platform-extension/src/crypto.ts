/// <reference types="chrome" />

import type {
	CryptoAdapter,
	EncryptedPayload,
	KdbxRawEntry,
	OpenKdbxInput,
	PasskeyAssertion,
	PasskeyImportResult,
	PasskeyRegistration,
	PasswordSlotBlob,
	SaveKdbxInput,
	UnwrapPasswordSlotInput,
	UnwrapWebauthnSlotInput,
	VekEncrypted,
	VerifyPasswordSlotInput,
	VerifyWebauthnSlotInput,
	WrapPasswordSlotInput,
	WrapWebauthnSlotInput,
} from "@core/adapters/crypto";
import type {
	CryptoDecrypt,
	CryptoDecryptBatch,
	CryptoDecryptOuter,
	CryptoEncrypt,
	CryptoEncryptOuter,
	CryptoPasskeyGet,
	CryptoPasskeyImportPkcs8,
	CryptoPasskeyMake,
	CryptoUnlockWithVek,
	CryptoUnwrapPasswordSlot,
	CryptoUnwrapWebauthnSlot,
	CryptoVerifyPasswordSlot,
	CryptoVerifyWebauthnSlot,
	CryptoWrapPasswordSlot,
	CryptoWrapWebauthnSlot,
} from "./crypto/messages";
import { api } from "./platform-api";

// Backstop a stalled offscreen round-trip (e.g. a cold-start createDocument that
// never resolves) so the UI surfaces a retryable error instead of hanging forever.
const SEND_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(
			() => reject(new Error(`${label} timed out — try again`)),
			SEND_TIMEOUT_MS,
		);
		promise.then(resolve, reject).finally(() => clearTimeout(t));
	});
}

// Every CRYPTO_* op carries an optional top-level vaultId (set by withVault). The background's
// vek-store keys the per-vault VEK map by it; an absent id resolves to the active vault.
async function dispatch<T = unknown>(
	type: string,
	payload: unknown,
	vaultId: string | undefined,
): Promise<T> {
	const res = await withTimeout(api.runtime.sendMessage({ type, vaultId, payload }), type);
	if (!res?.ok) throw new Error(res?.error ?? `crypto ${type} failed`);
	return res.data as T;
}

// Per-vault VEK session-key prefix (mirrors background/vek-store.ts). A view watches removal of
// its own vault's key as the cross-context lock signal, so locking vault A never locks vault B.
const VEK_KEY_PREFIX = "vault.vek:";

// sendMessage mangles Uint8Array into a plain object; send magicVersion as number[] instead.
function slotPayload(input: WrapPasswordSlotInput): CryptoWrapPasswordSlot {
	return {
		password: input.password,
		saltB64: input.saltB64,
		slotIdB64: input.slotIdB64,
		magicVersion: Array.from(input.magicVersion),
	};
}

function webauthnSlotPayload(input: WrapWebauthnSlotInput): CryptoWrapWebauthnSlot {
	return {
		hmacSecretB64: input.hmacSecretB64,
		slotIdB64: input.slotIdB64,
		magicVersion: Array.from(input.magicVersion),
	};
}

/** Build a crypto adapter whose ops target `vaultId` (undefined = the active vault). `withVault`
 * rebinds it; `useVault` scopes it to the active vault, like it scopes storage. */
function makeCrypto(vaultId?: string): CryptoAdapter {
	const send = <T = unknown>(type: string, payload?: unknown): Promise<T> =>
		dispatch<T>(type, payload, vaultId);

	return {
		withVault: (id: string) => makeCrypto(id),

		lock: () => send("CRYPTO_LOCK"),
		isLocked: () => send<boolean>("CRYPTO_IS_LOCKED"),

		onExternalLock(callback: () => void) {
			// Watch removal of this vault's own VEK session key. No id (base adapter, no active
			// vault) means nothing to watch.
			if (vaultId === undefined) return () => {};
			const key = `${VEK_KEY_PREFIX}${vaultId}`;
			const handler = (changes: Record<string, chrome.storage.StorageChange>) => {
				const change = changes[key];
				// Removal (value gone) means locked; a set value (unlock/resume) is self-driven, ignore.
				if (change && change.oldValue !== undefined && change.newValue === undefined) {
					callback();
				}
			};
			api.storage.session.onChanged.addListener(handler);
			return () => api.storage.session.onChanged.removeListener(handler);
		},

		onExternalChange(callback: () => void) {
			const handler = (message: { type?: string } | undefined) => {
				if (message?.type === "VAULT_CHANGED_EXTERNAL") callback();
			};
			api.runtime.onMessage.addListener(handler);
			return () => api.runtime.onMessage.removeListener(handler);
		},

		generateVek: () => send<string>("CRYPTO_GENERATE_VEK"),
		unlockWithVek: (vekB64) =>
			send("CRYPTO_UNLOCK_WITH_VEK", { vekB64 } satisfies CryptoUnlockWithVek),
		exportVek: () => send<string>("CRYPTO_EXPORT_VEK"),
		rotateVek: () => send<string>("CRYPTO_ROTATE_VEK"),

		generateSalt: () => send<string>("CRYPTO_GENERATE_SALT"),
		generateSlotId: () => send<string>("CRYPTO_GENERATE_SLOT_ID"),

		wrapVekPassword: (input: WrapPasswordSlotInput) =>
			send<PasswordSlotBlob>("CRYPTO_WRAP_PASSWORD_SLOT", slotPayload(input)),

		unwrapVekPassword: (input: UnwrapPasswordSlotInput) =>
			send<boolean>("CRYPTO_UNWRAP_PASSWORD_SLOT", {
				...slotPayload(input),
				verifierB64: input.verifierB64,
				wrapIvB64: input.wrapIvB64,
				wrappedVekB64: input.wrappedVekB64,
			} satisfies CryptoUnwrapPasswordSlot),

		verifyPasswordSlot: (input: VerifyPasswordSlotInput) =>
			send<boolean>("CRYPTO_VERIFY_PASSWORD_SLOT", {
				...slotPayload(input),
				verifierB64: input.verifierB64,
			} satisfies CryptoVerifyPasswordSlot),

		wrapVekWebauthn: (input: WrapWebauthnSlotInput) =>
			send<PasswordSlotBlob>("CRYPTO_WRAP_WEBAUTHN_SLOT", webauthnSlotPayload(input)),

		unwrapVekWebauthn: (input: UnwrapWebauthnSlotInput) =>
			send<boolean>("CRYPTO_UNWRAP_WEBAUTHN_SLOT", {
				...webauthnSlotPayload(input),
				verifierB64: input.verifierB64,
				wrapIvB64: input.wrapIvB64,
				wrappedVekB64: input.wrappedVekB64,
			} satisfies CryptoUnwrapWebauthnSlot),

		verifyWebauthnSlot: (input: VerifyWebauthnSlotInput) =>
			send<boolean>("CRYPTO_VERIFY_WEBAUTHN_SLOT", {
				...webauthnSlotPayload(input),
				verifierB64: input.verifierB64,
			} satisfies CryptoVerifyWebauthnSlot),

		encryptEntry: (plaintextJson) =>
			send<EncryptedPayload>("CRYPTO_ENCRYPT", { plaintextJson } satisfies CryptoEncrypt),
		decryptEntry: (payload) => send<string>("CRYPTO_DECRYPT", payload satisfies CryptoDecrypt),
		decryptEntries: (payloads) =>
			send<string[]>("CRYPTO_DECRYPT_BATCH", { entries: payloads } satisfies CryptoDecryptBatch),
		encryptWithVek: (plaintext) =>
			send<VekEncrypted>("CRYPTO_ENCRYPT_OUTER", { plaintext } satisfies CryptoEncryptOuter),
		decryptWithVek: (iv, ciphertext) =>
			send<string>("CRYPTO_DECRYPT_OUTER", { iv, ciphertext } satisfies CryptoDecryptOuter),

		openKdbx: (input: OpenKdbxInput) => send<KdbxRawEntry[]>("CRYPTO_OPEN_KDBX", input),
		// Reply is the .kdbx as base64; the message channel wouldn't preserve raw bytes.
		saveKdbx: (input: SaveKdbxInput) => send<string>("CRYPTO_SAVE_KDBX", input),

		passkeyMakeCredential: (rpId, userVerified) =>
			send<PasskeyRegistration>("CRYPTO_PASSKEY_MAKE", {
				rpId,
				userVerified,
			} satisfies CryptoPasskeyMake),
		passkeyGetAssertion: (rpId, privateKeyB64, clientDataHashB64, userVerified) =>
			send<PasskeyAssertion>("CRYPTO_PASSKEY_GET", {
				rpId,
				privateKeyB64,
				clientDataHashB64,
				userVerified,
			} satisfies CryptoPasskeyGet),
		passkeyImportPkcs8: (pkcs8B64) =>
			send<PasskeyImportResult>("CRYPTO_PASSKEY_IMPORT_PKCS8", {
				pkcs8B64,
			} satisfies CryptoPasskeyImportPkcs8),
	};
}

export const extensionCrypto: CryptoAdapter = makeCrypto();
