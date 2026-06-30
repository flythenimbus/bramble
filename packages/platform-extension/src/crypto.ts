/// <reference types="chrome" />

import type {
	CryptoAdapter,
	EncryptedPayload,
	KdbxRawEntry,
	OpenKdbxInput,
	PasskeyAssertion,
	PasskeyRegistration,
	PasswordSlotBlob,
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
	CryptoDecryptOuter,
	CryptoEncrypt,
	CryptoEncryptOuter,
	CryptoPasskeyGet,
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

async function send<T = unknown>(type: string, payload?: unknown): Promise<T> {
	const res = await withTimeout(api.runtime.sendMessage({ type, payload }), type);
	if (!res?.ok) throw new Error(res?.error ?? `crypto ${type} failed`);
	return res.data as T;
}

// Mirrors background.ts VEK_KEY. Its removal from session storage is our cross-context lock signal.
const VEK_SESSION_KEY = "vault.vek";

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

export const extensionCrypto: CryptoAdapter = {
	lock: () => send("CRYPTO_LOCK"),
	isLocked: () => send<boolean>("CRYPTO_IS_LOCKED"),

	onExternalLock(callback: () => void) {
		const handler = (changes: Record<string, chrome.storage.StorageChange>) => {
			const change = changes[VEK_SESSION_KEY];
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
	encryptWithVek: (plaintext) =>
		send<VekEncrypted>("CRYPTO_ENCRYPT_OUTER", { plaintext } satisfies CryptoEncryptOuter),
	decryptWithVek: (iv, ciphertext) =>
		send<string>("CRYPTO_DECRYPT_OUTER", { iv, ciphertext } satisfies CryptoDecryptOuter),

	openKdbx: (input: OpenKdbxInput) => send<KdbxRawEntry[]>("CRYPTO_OPEN_KDBX", input),

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
};
