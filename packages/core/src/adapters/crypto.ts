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
}

export interface OpenKdbxInput {
	fileB64: string;
	password: string;
	keyfileB64?: string;
}

/** Vault crypto operations (VEK lifecycle, slot wrap/unwrap, entry encryption, KeePass import). */
export interface CryptoAdapter {
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
	encryptWithVek(plaintext: string): Promise<VekEncrypted>;
	decryptWithVek(iv: string, ciphertext: string): Promise<string>;

	// Passkey provider (authenticator role). Pure crypto: mint generates the key,
	// assert signs with the stored private key. Neither needs the VEK loaded; the
	// private key is decrypted from its entry separately (decryptEntry) first.
	passkeyMakeCredential(rpId: string, userVerified: boolean): Promise<PasskeyRegistration>;
	passkeyGetAssertion(
		rpId: string,
		privateKeyB64: string,
		clientDataHashB64: string,
		userVerified: boolean,
	): Promise<PasskeyAssertion>;

	// Rejects with an Error whose message is a stable KDBX_* code (e.g.
	// KDBX_WRONG_CREDENTIAL) so the UI can branch on it.
	openKdbx(input: OpenKdbxInput): Promise<KdbxRawEntry[]>;
}
