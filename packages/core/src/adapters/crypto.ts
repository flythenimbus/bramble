export interface EncryptedPayload {
	ciphertext: string;
	iv: string;
	wrappedDek: string;
	dekIv: string;
}

export interface VekEncrypted {
	iv: string;
	ciphertext: string;
}

export interface PasswordSlotBlob {
	verifier: string;
	wrapIv: string;
	wrappedVek: string;
}

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

export interface KdbxRawEntry {
	strings: { key: string; value: string; protected: boolean }[];
}

export interface OpenKdbxInput {
	fileB64: string;
	password: string;
	keyfileB64?: string;
}

export interface CryptoAdapter {
	generateVek(): Promise<string>; // creates VEK + loads it; returns b64 for caching
	unlockWithVek(vekB64: string): Promise<void>; // session resume (offscreen restart)
	exportVek(): Promise<string>; // session resume (background cache)
	rotateVek(): Promise<string>;
	lock(): Promise<void>;
	isLocked(): Promise<boolean>;
	onExternalLock(callback: () => void): () => void;
	onExternalChange(callback: () => void): () => void;

	generateSalt(): Promise<string>;
	generateSlotId(): Promise<string>;

	wrapVekPassword(input: WrapPasswordSlotInput): Promise<PasswordSlotBlob>;
	unwrapVekPassword(input: UnwrapPasswordSlotInput): Promise<boolean>;
	verifyPasswordSlot(input: VerifyPasswordSlotInput): Promise<boolean>;

	wrapVekWebauthn(input: WrapWebauthnSlotInput): Promise<PasswordSlotBlob>;
	unwrapVekWebauthn(input: UnwrapWebauthnSlotInput): Promise<boolean>;
	verifyWebauthnSlot(input: VerifyWebauthnSlotInput): Promise<boolean>;

	encryptEntry(plaintextJson: string): Promise<EncryptedPayload>;
	decryptEntry(payload: EncryptedPayload): Promise<string>;
	encryptWithVek(plaintext: string): Promise<VekEncrypted>;
	decryptWithVek(iv: string, ciphertext: string): Promise<string>;

	openKdbx(input: OpenKdbxInput): Promise<KdbxRawEntry[]>;
}
