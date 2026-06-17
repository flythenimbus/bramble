// Builds a VLT1 vault blob from a loaded VEK: wrap the VEK into unlock slots and
// seal the entries payload under it. Shared by vault creation (popup, via the
// CryptoAdapter) and device enrollment (offscreen, via a wasm-backed adapter), so
// the slot/blob logic lives once. The caller is responsible for having the VEK
// loaded in its crypto context. See docs/vault-format.md, docs/p2p-sync.md.

import type { CryptoAdapter } from "../adapters/crypto";
import { type EntriesPayload, encodeEntriesPayload } from "../sync";
import { base64ToBytes } from "../util/bytes";
import {
	encodeVaultBlob,
	type PasswordSlot,
	type RecoverySlot,
	SLOT_KIND_PASSWORD,
	SLOT_KIND_RECOVERY,
	SLOT_KIND_WEBAUTHN,
	type Slot,
	type VaultBlob,
	verifierPrefix,
	type WebauthnSlot,
} from "../vault-format";

/** The crypto ops the builder needs; both the CryptoAdapter and a wasm wrapper satisfy this. */
export type VaultBuildCrypto = Pick<
	CryptoAdapter,
	"generateSalt" | "generateSlotId" | "wrapVekPassword" | "wrapVekWebauthn" | "encryptWithVek"
>;

// The fields common to a password and a recovery slot (everything but the kind).
async function wrapVek(
	crypto: VaultBuildCrypto,
	secret: string,
): Promise<Omit<PasswordSlot, "kind">> {
	const saltB64 = await crypto.generateSalt();
	const slotIdB64 = await crypto.generateSlotId();
	const wrapped = await crypto.wrapVekPassword({
		password: secret,
		saltB64,
		slotIdB64,
		magicVersion: verifierPrefix(),
	});
	return {
		slotId: base64ToBytes(slotIdB64),
		salt: base64ToBytes(saltB64),
		verifier: base64ToBytes(wrapped.verifier),
		wrapIv: base64ToBytes(wrapped.wrapIv),
		wrappedVek: base64ToBytes(wrapped.wrappedVek),
	};
}

/** Wrap the loaded VEK under a master password. */
export async function wrapPasswordSlot(
	crypto: VaultBuildCrypto,
	password: string,
): Promise<PasswordSlot> {
	return { kind: SLOT_KIND_PASSWORD, ...(await wrapVek(crypto, password)) };
}

/** Wrap the loaded VEK under a recovery code (same KDF as a password). */
export async function wrapRecoverySlot(
	crypto: VaultBuildCrypto,
	code: string,
): Promise<RecoverySlot> {
	return { kind: SLOT_KIND_RECOVERY, ...(await wrapVek(crypto, code)) };
}

/** Wrap the loaded VEK under a security key. salt + credentialId come from the PRF
 * ceremony (so unlock can re-derive); only the slot id is freshly generated. */
export async function wrapWebauthnSlot(
	crypto: VaultBuildCrypto,
	input: { hmacSecretB64: string; credentialId: Uint8Array; salt: Uint8Array },
): Promise<WebauthnSlot> {
	const slotIdB64 = await crypto.generateSlotId();
	const wrapped = await crypto.wrapVekWebauthn({
		hmacSecretB64: input.hmacSecretB64,
		slotIdB64,
		magicVersion: verifierPrefix(),
	});
	return {
		kind: SLOT_KIND_WEBAUTHN,
		slotId: base64ToBytes(slotIdB64),
		credentialId: input.credentialId,
		salt: input.salt,
		verifier: base64ToBytes(wrapped.verifier),
		wrapIv: base64ToBytes(wrapped.wrapIv),
		wrappedVek: base64ToBytes(wrapped.wrappedVek),
	};
}

/** Encode a vault blob: the given slots plus the entries payload sealed under the loaded VEK. */
export async function buildVaultBytes(
	crypto: VaultBuildCrypto,
	slots: Slot[],
	entries: EntriesPayload,
): Promise<Uint8Array> {
	const { iv, ciphertext } = await crypto.encryptWithVek(encodeEntriesPayload(entries));
	const blob: VaultBlob = {
		slots,
		entriesIv: base64ToBytes(iv),
		entriesCiphertext: base64ToBytes(ciphertext),
	};
	return encodeVaultBlob(blob);
}
