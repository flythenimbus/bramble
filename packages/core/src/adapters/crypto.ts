import type { FileRecord } from "../sync";
import type { FileSource } from "../vault/file-mutations";
import type { PortableVaultBlob } from "../wasm";
import type { HttpBodySource } from "./http";

/** An entry encrypted under a per-entry DEK that is itself wrapped by the VEK. */
export interface EncryptedPayload {
	ciphertext: string;
	iv: string;
	wrappedDek: string;
	dekIv: string;
}

/** A value encrypted directly under the VEK (outer blob). */
export interface VekEncrypted {
	iv: string;
	ciphertext: string;
}

/** A wrapped-VEK slot blob: verifier plus the VEK encrypted under the slot's KEK. */
export interface PasswordSlotBlob {
	verifier: string;
	wrapIv: string;
	wrappedVek: string;
}

/**
 * A freshly minted passkey (provider role). `privateKey` is the only secret; the
 * caller stores it inside the entry. The rest go to the relying party. All base64.
 */
export interface PasskeyRegistration {
	credentialId: string;
	publicKeyCose: string;
	privateKey: string;
	attestationObject: string;
	/** authenticatorData, also embedded in the attestation object; the response JSON needs it as a sibling. */
	authenticatorData: string;
	/** SPKI DER of the public key (base64); Chrome's proxy requires response.publicKey. */
	publicKey: string;
}

/** PKCS#8 key material converted to Bramble's stored representation. All base64. */
export interface PasskeyImportResult {
	/** 32 bytes either way: a P-256 scalar for ES256, an Ed25519 seed for EdDSA. */
	privateKey: string;
	publicKeyCose: string;
	/** COSE algorithm, read from the key's own OID. Store it: the bytes above can't say. */
	alg: number;
}

/** A passkey assertion: the two parts that require the private key. All base64. */
export interface PasskeyAssertion {
	authenticatorData: string;
	signature: string;
}

/** Slot-operation inputs. Bytes ride as base64 to survive chrome.runtime.sendMessage. */
export interface WrapPasswordSlotInput {
	password: string;
	saltB64: string;
	slotIdB64: string;
	magicVersion: Uint8Array;
}

export interface UnwrapPasswordSlotInput extends WrapPasswordSlotInput {
	verifierB64: string;
	wrapIvB64: string;
	wrappedVekB64: string;
}

export interface VerifyPasswordSlotInput extends WrapPasswordSlotInput {
	verifierB64: string;
}

/** WebAuthn slot input. The 32-byte hmac-secret is the only secret; credentialId is metadata. */
export interface WrapWebauthnSlotInput {
	hmacSecretB64: string;
	slotIdB64: string;
	magicVersion: Uint8Array;
}

export interface UnwrapWebauthnSlotInput extends WrapWebauthnSlotInput {
	verifierB64: string;
	wrapIvB64: string;
	wrappedVekB64: string;
}

export interface VerifyWebauthnSlotInput extends WrapWebauthnSlotInput {
	verifierB64: string;
}

/** One entry from a foreign KeePass database: raw String key/value pairs, protected values already decrypted in WASM. */
export interface KdbxRawEntry {
	strings: { key: string; value: string; protected: boolean }[];
	/** The entry's attachments: each its name, and which of the database's `attachments`. */
	binaries?: { name: string; index: number }[];
}

export interface OpenKdbxInput {
	file: Uint8Array;
	password: string;
	keyfile?: Uint8Array;
}

/** A KeePass database opened for import. */
export interface KdbxOpened {
	entries: KdbxRawEntry[];
	/** Its attachments, in the form this platform's sealer reads: unpacked files on desktop and
	 * mobile, staged copies on the extension. Entries refer to them by index. */
	attachments: { source: FileSource; size: number }[];
	/** Drop whatever holds the attachments, once they are sealed or the import is abandoned.
	 * They are the database's files in the clear, so this is not left to the lock alone. */
	release(): Promise<void>;
}

/** One entry to write into a .kdbx: the same String pairs the read side returns. */
export interface KdbxSaveEntry {
	strings: { key: string; value: string; protected: boolean }[];
}

/** One attachment to carry into a KDBX export: on the entry at `entry` in its `entries`, under
 * `name`, which is unique on that entry (KeePass keys an entry's attachments by name). */
export interface KdbxSaveFile {
	entry: number;
	record: FileRecord;
	name: string;
}

export interface SaveKdbxInput {
	/** The vault whose attachments these are. */
	vaultId: string;
	/** The exported file's name, for a platform that writes it to disk itself. */
	name: string;
	entries: KdbxSaveEntry[];
	/** The password that will unlock the exported file. Chosen for the export, not the vault's. */
	password: string;
	/** Every live attachment, written as a KeePass attachment on its entry. */
	files: KdbxSaveFile[];
}

/** A written KeePass file, read on demand, and `release` to delete whatever it left on disk once
 * the file has been saved where the user wants it. */
export type SavedKdbx = HttpBodySource & { release?: () => Promise<void> };

/**
 * Stable codes a platform adapter puts at the START of a rejection message, so the UI can show
 * translated copy instead of internal wording. Anything after the code is diagnostic detail for
 * the console and is never rendered. Defined here rather than per-platform so the extension and
 * mobile agree; see `useCryptoErrorMessage`.
 */
export const CRYPTO_SESSION_CHANGED = "vek_session_changed";
export const CRYPTO_PERSISTENCE_FAILED = "vek_persistence_failed";
/** A vault's key unwrapped but its entries did not load; the vault was locked again. */
export const VAULT_OPEN_FAILED = "VAULT_OPEN_FAILED";

/** Vault crypto operations (VEK lifecycle, slot wrap/unwrap, entry encryption, KeePass import). */
export interface CryptoAdapter {
	// Return an adapter bound to a specific vault id, so every VEK-scoped op it sends targets
	// that vault's key (the extension holds a per-vault VEK map in the background). Optional so
	// the mobile native adapter, which is single-active-vault, need not implement it. See
	// docs/multiple-vaults.md "Per-vault VEK".
	withVault?(vaultId: string): CryptoAdapter;

	generateVek(): Promise<string>; // creates VEK + loads it; returns b64 for caching
	unlockWithVek(vekB64: string): Promise<void>; // session resume (offscreen restart)
	exportVek(): Promise<string>; // session resume (background cache)
	// Replaces the in-memory VEK. Caller must re-wrap every slot and re-encrypt
	// every entry before persisting. Returns the new VEK b64.
	rotateVek(): Promise<string>;
	lock(): Promise<void>;
	isLocked(): Promise<boolean>;
	// Fires on a session lock from outside this UI context (background auto-lock).
	// Does NOT fire on unlock/resume. Returns an unsubscribe function.
	onExternalLock(callback: () => void): () => void;
	// Fires on vault-content changes from outside this UI context (background
	// corner-prompt save). Returns an unsubscribe function.
	onExternalChange(callback: () => void): () => void;

	generateSalt(): Promise<string>;
	generateSlotId(): Promise<string>;

	wrapVekPassword(input: WrapPasswordSlotInput): Promise<PasswordSlotBlob>;
	unwrapVekPassword(input: UnwrapPasswordSlotInput): Promise<boolean>;
	verifyPasswordSlot(input: VerifyPasswordSlotInput): Promise<boolean>;

	// Same shape as the password slot; only KEK derivation differs (HKDF over
	// hmac-secret vs. Argon2id over a password).
	wrapVekWebauthn(input: WrapWebauthnSlotInput): Promise<PasswordSlotBlob>;
	unwrapVekWebauthn(input: UnwrapWebauthnSlotInput): Promise<boolean>;
	verifyWebauthnSlot(input: VerifyWebauthnSlotInput): Promise<boolean>;

	encryptEntry(plaintextJson: string): Promise<EncryptedPayload>;
	decryptEntry(payload: EncryptedPayload): Promise<string>;
	// Decrypt many entries in one call. On the extension this is a single offscreen
	// round-trip (vs one per entry), which dominates open time on large vaults.
	// Returns plaintexts in the same order as `payloads`. A failed entry is null; only a
	// locked vault rejects.
	decryptEntries(payloads: EncryptedPayload[]): Promise<(string | null)[]>;
	encryptWithVek(plaintext: string): Promise<VekEncrypted>;
	decryptWithVek(iv: string, ciphertext: string): Promise<string>;

	// Passkey provider (authenticator role). Pure crypto: mint generates the key,
	// assert signs with the stored private key. Neither needs the VEK loaded; the
	// private key is decrypted from its entry separately (decryptEntry) first.
	passkeyMakeCredential(rpId: string, userVerified: boolean): Promise<PasskeyRegistration>;
	passkeyImportPkcs8(pkcs8B64: string): Promise<PasskeyImportResult>;
	passkeyGetAssertion(
		rpId: string,
		privateKeyB64: string,
		/** The credential's stored `alg`. The core refuses one it can't sign for. */
		alg: number,
		clientDataHashB64: string,
		userVerified: boolean,
	): Promise<PasskeyAssertion>;

	// Rejects with an Error whose message is a stable KDBX_* code (e.g.
	// KDBX_WRONG_CREDENTIAL) so the UI can branch on it.
	openKdbx(input: OpenKdbxInput): Promise<KdbxOpened>;
	/**
	 * Write a KDBX4 database (AES-256-CBC + Argon2id) holding `entries` and their attachments,
	 * unlocked by `password` alone. Resolves to the file as a source read on demand: with
	 * attachments it has no size limit, so it is written a piece at a time and never held.
	 * Optional: absent where there is no writer (the mobile dev browser). Where the file is on
	 * disk the source names its `path`, and `release` deletes it once the shell has saved it.
	 */
	saveKdbx?(input: SaveKdbxInput): Promise<SavedKdbx>;

	/**
	 * Seal `entriesJson` into a portable vault under a key generated for that file alone,
	 * leaving the session VEK untouched. The caller frames the result as a VLT1 blob.
	 * Unlike `saveKdbx` this is lossless, so it is the export that carries passkeys.
	 *
	 * Optional, like `saveKdbx`: a platform opts in once its binding layer exposes the
	 * core calls, and the UI gates on their presence rather than showing a broken action.
	 */
	sealPortableVault?(input: SealPortableVaultInput): Promise<PortableVaultBlob>;
	/** Open one. Resolves null for a wrong password, rejects for a corrupt file. */
	openPortableVault?(input: OpenPortableVaultInput): Promise<string | null>;
}

export interface SealPortableVaultInput {
	entriesJson: string;
	/** Protects this file only; deliberately not the master password. */
	password: string;
	magicVersion: Uint8Array;
}

export interface OpenPortableVaultInput {
	password: string;
	file: PortableVaultBlob;
	magicVersion: Uint8Array;
}
