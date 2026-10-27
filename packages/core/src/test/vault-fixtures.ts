// Vault bytes and records for tests that need well-formed ones but never really open them.

import type { EntryData } from "../hooks/useVault";
import type { FileRecord } from "../sync";
import { emptyVaultEntries, type VaultEntries } from "../vault/entry-mutations";
import {
	encodeVaultBlob,
	LEN_IV,
	LEN_SALT,
	LEN_SLOT_ID,
	LEN_VERIFIER,
	LEN_WRAP_IV,
	LEN_WRAPPED_VEK,
	type PasswordSlot,
	SLOT_KIND_PASSWORD,
	type VaultBlob,
} from "../vault-format";

/** `n` bytes counting up from `base`: distinct per base, and readable in a failure diff. */
export const fill = (n: number, base: number): Uint8Array =>
	Uint8Array.from({ length: n }, (_, i) => (base + i) & 0xff);

/** A well-formed password slot. Its bytes are filler: nothing here unwraps it. */
export function passwordSlot(): PasswordSlot {
	return {
		kind: SLOT_KIND_PASSWORD,
		slotId: fill(LEN_SLOT_ID, 0x10),
		salt: fill(LEN_SALT, 0x20),
		verifier: fill(LEN_VERIFIER, 0x30),
		wrapIv: fill(LEN_WRAP_IV, 0x40),
		wrappedVek: fill(LEN_WRAPPED_VEK, 0x50),
	};
}

/** A one-slot vault holding `entriesCiphertext`, empty by default. */
export function testVaultBlob(entriesCiphertext: Uint8Array = new Uint8Array(0)): VaultBlob {
	return { slots: [passwordSlot()], entriesIv: fill(LEN_IV, 0x70), entriesCiphertext };
}

/** The same, encoded as it sits on disk. */
export const testVaultBytes = (entriesCiphertext?: Uint8Array): Uint8Array =>
	encodeVaultBlob(testVaultBlob(entriesCiphertext));

/** A file record whose crypto fields are placeholders, for code that routes records and never
 * opens one. */
export function fileRecord(overrides: Partial<FileRecord> = {}): FileRecord {
	return {
		id: "f1",
		hlc: { wall: 1, counter: 0, node: "n" },
		hash: "a".repeat(64),
		size: 100,
		wrappedFek: "wf",
		fekIv: "fi",
		noncePrefix: "np",
		metaBlob: "mb",
		metaIv: "mi",
		...overrides,
	};
}

export const emptyEntries = (): VaultEntries => emptyVaultEntries();

export const loginEntry = (name: string): EntryData => ({
	type: "login",
	name,
	urls: [],
	username: "u",
	password: "p",
});
