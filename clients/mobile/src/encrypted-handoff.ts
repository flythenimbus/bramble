import { mobileCrypto } from "./adapters/crypto";

export interface EncryptedRecord {
	iv: string;
	ciphertext: string;
}

/** The native side of a provider handoff: AutofillBridge, on both platforms. */
export interface HandoffBridge {
	consume(): Promise<{ pending: EncryptedRecord[] }>;
	restore(o: { keep: EncryptedRecord[] }): Promise<void>;
}

/**
 * Drain a provider -> app handoff: each pending record decrypted with the active vault's VEK and
 * passed to `read` (null drops it). A record another vault sealed goes back for that vault. The
 * native side clears and restores under the provider's own lock, so an append meanwhile survives.
 */
export async function drainHandoff<T>(
	bridge: HandoffBridge,
	read: (json: unknown) => T | null,
): Promise<T[]> {
	const pending = (await bridge.consume().catch(() => null))?.pending ?? [];
	const out: T[] = [];
	const keep: EncryptedRecord[] = [];
	for (const record of pending) {
		let plaintext: string;
		try {
			plaintext = await mobileCrypto.decryptWithVek(record.iv, record.ciphertext);
		} catch {
			keep.push(record);
			continue;
		}
		try {
			const item = read(JSON.parse(plaintext));
			if (item !== null) out.push(item);
		} catch {
			// Decrypted but unreadable: no vault could use it, so it isn't put back.
		}
	}
	if (keep.length) await bridge.restore({ keep }).catch(() => {});
	return out;
}
