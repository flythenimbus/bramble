/// <reference types="chrome" />
import type {
	CryptoAdapter,
	EncryptedPayload,
	KdbxRawEntry,
	OpenKdbxInput,
	PasswordSlotBlob,
	UnwrapPasswordSlotInput,
	UnwrapWebauthnSlotInput,
	VekEncrypted,
	VerifyPasswordSlotInput,
	VerifyWebauthnSlotInput,
	WrapPasswordSlotInput,
	WrapWebauthnSlotInput,
} from "@core/adapters/crypto";

async function send<T = unknown>(type: string, payload?: unknown): Promise<T> {
	const res = await chrome.runtime.sendMessage({ type, payload });
	if (!res?.ok) throw new Error(res?.error ?? `crypto ${type} failed`);
	return res.data as T;
}

const VEK_SESSION_KEY = "vault.vek";

function slotPayload(input: WrapPasswordSlotInput) {
	return {
		password: input.password,
		saltB64: input.saltB64,
		slotIdB64: input.slotIdB64,
		magicVersion: Array.from(input.magicVersion),
	};
}

function webauthnSlotPayload(input: WrapWebauthnSlotInput) {
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
			if (change && change.oldValue !== undefined && change.newValue === undefined) {
				callback();
			}
		};
		chrome.storage.session.onChanged.addListener(handler);
		return () => chrome.storage.session.onChanged.removeListener(handler);
	},

	onExternalChange(callback: () => void) {
		const handler = (message: { type?: string } | undefined) => {
			if (message?.type === "VAULT_CHANGED_EXTERNAL") callback();
		};
		chrome.runtime.onMessage.addListener(handler);
		return () => chrome.runtime.onMessage.removeListener(handler);
	},

	generateVek: () => send<string>("CRYPTO_GENERATE_VEK"),
	unlockWithVek: (vekB64) => send("CRYPTO_UNLOCK_WITH_VEK", { vekB64 }),
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
		}),

	verifyPasswordSlot: (input: VerifyPasswordSlotInput) =>
		send<boolean>("CRYPTO_VERIFY_PASSWORD_SLOT", {
			...slotPayload(input),
			verifierB64: input.verifierB64,
		}),

	wrapVekWebauthn: (input: WrapWebauthnSlotInput) =>
		send<PasswordSlotBlob>("CRYPTO_WRAP_WEBAUTHN_SLOT", webauthnSlotPayload(input)),

	unwrapVekWebauthn: (input: UnwrapWebauthnSlotInput) =>
		send<boolean>("CRYPTO_UNWRAP_WEBAUTHN_SLOT", {
			...webauthnSlotPayload(input),
			verifierB64: input.verifierB64,
			wrapIvB64: input.wrapIvB64,
			wrappedVekB64: input.wrappedVekB64,
		}),

	verifyWebauthnSlot: (input: VerifyWebauthnSlotInput) =>
		send<boolean>("CRYPTO_VERIFY_WEBAUTHN_SLOT", {
			...webauthnSlotPayload(input),
			verifierB64: input.verifierB64,
		}),

	encryptEntry: (plaintextJson) => send<EncryptedPayload>("CRYPTO_ENCRYPT", { plaintextJson }),
	decryptEntry: (payload) => send<string>("CRYPTO_DECRYPT", payload),
	encryptWithVek: (plaintext) => send<VekEncrypted>("CRYPTO_ENCRYPT_OUTER", { plaintext }),
	decryptWithVek: (iv, ciphertext) => send<string>("CRYPTO_DECRYPT_OUTER", { iv, ciphertext }),

	openKdbx: (input: OpenKdbxInput) => send<KdbxRawEntry[]>("CRYPTO_OPEN_KDBX", input),
};
