export interface EncryptedPayload {
	ciphertext: string;
	iv: string;
	wrappedDek: string;
	dekIv: string;
}

export interface MasterEncrypted {
	iv: string;
	ciphertext: string;
}

export interface CryptoAdapter {
	unlock(password: string, saltB64: string): Promise<void>;
	lock(): Promise<void>;
	isLocked(): Promise<boolean>;
	encryptEntry(plaintextJson: string): Promise<EncryptedPayload>;
	decryptEntry(payload: EncryptedPayload): Promise<string>;
	generateSalt(): Promise<string>;
	verifierFor(magicBytes: Uint8Array): Promise<Uint8Array>;
	verifyPassword(password: string, saltB64: string): Promise<boolean>;
	encryptWithMaster(plaintext: string): Promise<MasterEncrypted>;
	decryptWithMaster(iv: string, ciphertext: string): Promise<string>;
	changePassword(
		newPassword: string,
		newSaltB64: string,
		entries: EncryptedPayload[],
	): Promise<EncryptedPayload[]>;
}
