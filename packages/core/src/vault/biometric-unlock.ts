import type { BiometricUnlock } from "../adapters/biometric";
import type { CryptoAdapter } from "../adapters/crypto";

// The two adapter-bound steps of device-local biometric unlock, kept off the React
// hook so they can be unit-tested against fake adapters (mirrors vault/build-vault).
// The VEK transits as base64 here exactly as it does during session resume; the
// biometric adapter is responsible for the OS-gated cache, the crypto adapter for the
// in-memory session.

/** Cache the in-memory VEK behind the device biometric gate, keyed to this vault. The vault must be unlocked. */
export async function enableBiometricUnlock(
	crypto: CryptoAdapter,
	biometric: BiometricUnlock,
	vaultId: string,
): Promise<void> {
	const vek = await crypto.exportVek();
	await biometric.enable(vek, vaultId);
}

/** Biometric-unwrap this vault's cached VEK and load it into the crypto session. The caller
 * reloads entries afterward. Throws if the gate is unavailable or the user cancels. */
export async function unlockVekWithBiometric(
	crypto: CryptoAdapter,
	biometric: BiometricUnlock,
	vaultId: string,
): Promise<void> {
	const vek = await biometric.unlock(vaultId);
	await crypto.unlockWithVek(vek);
}

/** Full biometric unlock with stale-cache recovery: load the gated VEK, then load
 * entries. If the gate authenticated but its VEK no longer opens this vault (e.g. the
 * vault was reset under it), tear the session + cache down so the UI falls back to the
 * password screen, signal it via `onStaleCache`, and throw a friendly message. The hook
 * supplies the side effects; this keeps the recovery logic unit-testable off React. */
export async function biometricUnlockFlow(opts: {
	crypto: CryptoAdapter;
	biometric: BiometricUnlock;
	vaultId: string;
	loadEntries: () => Promise<void>;
	onStaleCache: () => void;
}): Promise<void> {
	await unlockVekWithBiometric(opts.crypto, opts.biometric, opts.vaultId);
	try {
		await opts.loadEntries();
	} catch (cause) {
		await opts.crypto.lock().catch(() => {});
		await opts.biometric.disable(opts.vaultId).catch(() => {});
		opts.onStaleCache();
		console.error("[vault] biometric VEK failed to open the vault; cache cleared:", cause);
		throw new Error("Biometric unlock is out of date. Unlock with your password to re-enable it.");
	}
}
