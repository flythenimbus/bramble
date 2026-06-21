import type { BiometricUnlock } from "../adapters/biometric";
import type { CryptoAdapter } from "../adapters/crypto";

// The two adapter-bound steps of device-local biometric unlock, kept off the React
// hook so they can be unit-tested against fake adapters (mirrors vault/build-vault).
// The VEK transits as base64 here exactly as it does during session resume; the
// biometric adapter is responsible for the OS-gated cache, the crypto adapter for the
// in-memory session.

/** Cache the in-memory VEK behind the device biometric gate. The vault must be unlocked. */
export async function enableBiometricUnlock(
	crypto: CryptoAdapter,
	biometric: BiometricUnlock,
): Promise<void> {
	const vek = await crypto.exportVek();
	await biometric.enable(vek);
}

/** Biometric-unwrap the cached VEK and load it into the crypto session. The caller
 * reloads entries afterward. Throws if the gate is unavailable or the user cancels. */
export async function unlockVekWithBiometric(
	crypto: CryptoAdapter,
	biometric: BiometricUnlock,
): Promise<void> {
	const vek = await biometric.unlock();
	await crypto.unlockWithVek(vek);
}
