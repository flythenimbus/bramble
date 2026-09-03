import { type BiometricUnlock, isBiometricInvalidated } from "../adapters/biometric";
import type { CryptoAdapter } from "../adapters/crypto";
import { withTimeout } from "../util/with-timeout";

// The two adapter-bound steps of device-local biometric unlock, kept off the React
// hook so they can be unit-tested against fake adapters (mirrors vault/build-vault).
// The VEK transits as base64 here exactly as it does during session resume; the
// biometric adapter is responsible for the OS-gated cache, the crypto adapter for the
// in-memory session.
//
// `allowPasscode` (iOS) is fixed into the cached VEK's OS gate when it is written, so it is
// threaded through both the enable and the unlock side: the prompt has to ask for the same
// thing the item was armed with. See docs/auth-and-unlock.md.

/** The gate to actually ask for, given the setting and what the device has enrolled. With no
 * biometric enrolled there is no biometry-only access control to build, so the passcode is the
 * only thing that can hold the cache and the preference doesn't get a say - asking for
 * biometrics-only there would fail to arm and, worse, fail to unlock. Both the unlock screen and
 * Settings resolve it through here so they can't disagree about which gate the item carries. */
export function effectiveAllowPasscode(biometryEnrolled: boolean, prefAllows: boolean): boolean {
	return !biometryEnrolled || prefAllows;
}

// Neither step here waits on a person: exporting the VEK is a memory read, and arming the gate
// is a Keychain/Keystore WRITE, which by contract never prompts. So either one taking seconds
// means it is not coming back. On device that stalled the Settings toggle mid-flight - `busy`
// never cleared, so the row read as off and disabled with no error - and left the vault with no
// gate armed. Bounded so a stall becomes a named failure the user (and we) can act on.
// Deliberately NOT applied to unlock: that one does wait on a person answering Face ID.
const GATE_WRITE_TIMEOUT_MS = 10_000;

/** Cache the in-memory VEK behind the device biometric gate, keyed to this vault. The vault must be unlocked. */
export async function enableBiometricUnlock(
	crypto: CryptoAdapter,
	biometric: BiometricUnlock,
	vaultId: string,
	allowPasscode: boolean,
): Promise<void> {
	// The label names the step that was WAITING, which is not always the step at fault: iOS
	// dispatches every Capacitor plugin call on one serial queue, so a stall anywhere upstream
	// surfaces here. Treat it as "a native call stopped answering", not as an accusation.
	const vek = await withTimeout(
		crypto.exportVek(),
		GATE_WRITE_TIMEOUT_MS,
		"Reading this vault's key",
	);
	await withTimeout(
		biometric.enable(vek, vaultId, allowPasscode),
		GATE_WRITE_TIMEOUT_MS,
		"Saving the key to this device",
	);
}

/** Biometric-unwrap this vault's cached VEK and load it into the crypto session. The caller
 * reloads entries afterward. Throws if the gate is unavailable or the user cancels. */
export async function unlockVekWithBiometric(
	crypto: CryptoAdapter,
	biometric: BiometricUnlock,
	vaultId: string,
	allowPasscode: boolean,
): Promise<void> {
	const vek = await biometric.unlock(vaultId, allowPasscode);
	await crypto.unlockWithVek(vek);
}

/** The cached VEK no longer opens this vault, so the gate has been torn down. The one biometric
 * failure worth putting on screen unasked: the button it came from is gone with it. */
export class StaleBiometricCacheError extends Error {}

/** Re-cache the VEK under the gate the settings now ask for. The OS access control is chosen
 * when the item is written, so this is the only way to change it - and running it after every
 * unlock is also what converts a device armed by an older build, which had no such setting and
 * always allowed the passcode. A no-op when the gate isn't set up; never prompts. */
export async function reconcileBiometricGate(opts: {
	crypto: CryptoAdapter;
	biometric: BiometricUnlock;
	vaultId: string;
	enabled: boolean;
	allowPasscode: boolean;
}): Promise<void> {
	if (!opts.enabled) return;
	await enableBiometricUnlock(opts.crypto, opts.biometric, opts.vaultId, opts.allowPasscode);
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
	allowPasscode: boolean;
	loadEntries: () => Promise<void>;
	onStaleCache: () => void;
}): Promise<void> {
	try {
		await unlockVekWithBiometric(opts.crypto, opts.biometric, opts.vaultId, opts.allowPasscode);
	} catch (cause) {
		// The OS discarded the cached VEK because the enrolled biometric set changed (iOS
		// biometrics-only, and Android always). Nothing can reopen it, so retire the gate here
		// rather than leave a button that can only ever fail. The native side has already
		// dropped the item; this is the UI half.
		if (isBiometricInvalidated(cause)) {
			await opts.biometric.disable(opts.vaultId).catch(() => {});
			opts.onStaleCache();
		}
		throw cause;
	}
	try {
		await opts.loadEntries();
	} catch (cause) {
		await opts.crypto.lock().catch(() => {});
		await opts.biometric.disable(opts.vaultId).catch(() => {});
		opts.onStaleCache();
		console.error("[vault] biometric VEK failed to open the vault; cache cleared:", cause);
		throw new StaleBiometricCacheError(
			"Biometric unlock is out of date. Unlock with your password to re-enable it.",
		);
	}
}
