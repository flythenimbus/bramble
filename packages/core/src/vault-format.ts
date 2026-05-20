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

export function encodeVaultBlob(_blob: VaultBlob): Uint8Array {
  throw new Error("TODO");
}

export function decodeVaultBlob(_bytes: Uint8Array): VaultBlob {
  throw new Error("TODO");
}
