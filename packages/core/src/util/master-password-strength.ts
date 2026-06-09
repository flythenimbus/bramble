import { passwordStrength } from "check-password-strength";

// Master-password policy: a hard length floor (rejected outright), then inform
// rather than forbid: weak-but-usable raises a non-blocking warning.

const MIN_MASTER_PASSWORD_LENGTH = 8;
// check-password-strength: 0 Too weak, 1 Weak, 2 Medium, 3 Strong. We warn below Medium.
const MIN_RECOMMENDED_STRENGTH = 2;

export interface MasterPasswordStrength {
	id: number;
	label: string;
}

/** Strength score (id + label) for a candidate master password. */
export function masterPasswordStrength(password: string): MasterPasswordStrength {
	const s = passwordStrength(password);
	return { id: s.id, label: s.value };
}

/** Blocking validator: returns a message only for too-short input. Empty is left to the form's required. */
export function masterPasswordHardError(password: string): string | undefined {
	if (!password) return undefined;
	if (password.length < MIN_MASTER_PASSWORD_LENGTH) {
		return `Use at least ${MIN_MASTER_PASSWORD_LENGTH} characters.`;
	}
	return undefined;
}

/** Non-blocking advisory: returns a warning for a password that clears the floor but is still weak. */
export function masterPasswordWarning(password: string): string | undefined {
	if (!password || masterPasswordHardError(password)) return undefined;
	if (masterPasswordStrength(password).id >= MIN_RECOMMENDED_STRENGTH) return undefined;
	return "This password is weak. Anyone who gets your vault file could crack it offline.";
}
