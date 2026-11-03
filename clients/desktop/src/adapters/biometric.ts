import type { BiometricUnlock, BiometryType } from "@core/index";
import { invoke } from "@tauri-apps/api/core";
import { markUnlocked } from "./vault-session";

// Touch ID (and later Windows Hello) from src-tauri/src/biometric.rs. The gate holds the key
// natively: arming reads the VEK from the Rust crypto session and unlocking installs it there, so
// nothing here ever sees the key. Rejections are `{ code, message }`, which the core's
// isBiometricCancel and friends read. See docs/desktop-biometric-unlock.md.

interface Status {
	available: boolean;
	biometryType: string;
	biometryEnrolled: boolean;
}

const NONE: Status = { available: false, biometryType: "", biometryEnrolled: false };

// Swallowed like mobile's probes: a build that can't reach the gate hides the feature.
const status = () => invoke<Status>("biometric_status").catch(() => NONE);

export const desktopBiometric: BiometricUnlock = {
	holdsKeyNatively: true,
	// Re-arming prompts on both: macOS guards deleting the old Touch ID item with Touch ID (its own
	// "needs to authenticate" sheet, which appeared right after every unlock while this was true),
	// and Windows Hello signs to derive its key. So the core never re-arms behind the user's back;
	// a passcode-fallback change re-arms from Settings, where the prompt is expected.
	enableIsSilent: false,
	async isAvailable() {
		return (await status()).available;
	},
	async biometryType(): Promise<BiometryType> {
		const t = (await status()).biometryType;
		return t === "touchId" || t === "windowsHello" ? t : "biometric";
	},
	async biometryEnrolled() {
		return (await status()).biometryEnrolled;
	},
	isEnabled: (vaultId) => invoke<boolean>("biometric_is_enabled", { vaultId }).catch(() => false),
	enable: (_vek, vaultId, allowPasscode) =>
		invoke<void>("biometric_enable", { vaultId, allowPasscode }),
	async unlock(vaultId, allowPasscode) {
		await invoke<void>("biometric_unlock", { vaultId, allowPasscode });
		// The key is loaded now, which unlockWithVek would otherwise have reported (./crypto.ts).
		markUnlocked();
		return null;
	},
	disable: (vaultId) => invoke<void>("biometric_disable", { vaultId }),
};
