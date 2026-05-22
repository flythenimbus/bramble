export const MAGIC = new Uint8Array([0x56, 0x4c, 0x54, 0x31]);
export const VERSION = 0x01;

export const OFFSET_MAGIC = 0;
export const OFFSET_VERSION = 4;
export const OFFSET_SALT = 5;
export const OFFSET_VERIFIER = 21;
export const OFFSET_ENTRIES_IV = 53;
export const OFFSET_ENTRIES = 65;

export const LEN_SALT = 16;
export const LEN_VERIFIER = 32;
export const LEN_IV = 12;

export interface EncryptedEntry {
	id: string;
	wrappedDek: string;
	dekIv: string;
	ciphertext: string;
	iv: string;
}

export interface VaultBlob {
	salt: Uint8Array;
	verifier: Uint8Array;
	entriesIv: Uint8Array;
	entriesCiphertext: Uint8Array;
}

export function encodeVaultBlob(blob: VaultBlob): Uint8Array {
	if (blob.salt.length !== LEN_SALT) {
		throw new Error(`salt must be ${LEN_SALT} bytes, got ${blob.salt.length}`);
	}
	if (blob.verifier.length !== LEN_VERIFIER) {
		throw new Error(`verifier must be ${LEN_VERIFIER} bytes, got ${blob.verifier.length}`);
	}
	if (blob.entriesIv.length !== LEN_IV) {
		throw new Error(`entriesIv must be ${LEN_IV} bytes, got ${blob.entriesIv.length}`);
	}

	const out = new Uint8Array(OFFSET_ENTRIES + blob.entriesCiphertext.length);
	out.set(MAGIC, OFFSET_MAGIC);
	out[OFFSET_VERSION] = VERSION;
	out.set(blob.salt, OFFSET_SALT);
	out.set(blob.verifier, OFFSET_VERIFIER);
	out.set(blob.entriesIv, OFFSET_ENTRIES_IV);
	out.set(blob.entriesCiphertext, OFFSET_ENTRIES);
	return out;
}

export function decodeVaultBlob(bytes: Uint8Array): VaultBlob {
	if (bytes.length < OFFSET_ENTRIES) {
		throw new Error(
			`vault blob too short: ${bytes.length} bytes (need at least ${OFFSET_ENTRIES})`,
		);
	}

	for (let i = 0; i < MAGIC.length; i++) {
		if (bytes[OFFSET_MAGIC + i] !== MAGIC[i]) {
			throw new Error("invalid vault magic bytes (not a VLT1 file)");
		}
	}

	const version = bytes[OFFSET_VERSION];
	if (version !== VERSION) {
		throw new Error(`unsupported vault version: ${version} (expected ${VERSION})`);
	}

	return {
		salt: bytes.slice(OFFSET_SALT, OFFSET_SALT + LEN_SALT),
		verifier: bytes.slice(OFFSET_VERIFIER, OFFSET_VERIFIER + LEN_VERIFIER),
		entriesIv: bytes.slice(OFFSET_ENTRIES_IV, OFFSET_ENTRIES_IV + LEN_IV),
		entriesCiphertext: bytes.slice(OFFSET_ENTRIES),
	};
}
