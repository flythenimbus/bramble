import { passwordStrength } from "check-password-strength";


const MIN_MASTER_PASSWORD_LENGTH = 8;
const MIN_RECOMMENDED_STRENGTH = 2;

export interface MasterPasswordStrength {
	id: number;
	label: string;
}

export function masterPasswordStrength(password: string): MasterPasswordStrength {
	const s = passwordStrength(password);
	return { id: s.id, label: s.value };
}

export function masterPasswordHardError(password: string): string | undefined {
	if (!password) return undefined;
	if (password.length < MIN_MASTER_PASSWORD_LENGTH) {
		return `Use at least ${MIN_MASTER_PASSWORD_LENGTH} characters.`;
	}
	return undefined;
}

export function masterPasswordWarning(password: string): string | undefined {
	if (!password || masterPasswordHardError(password)) return undefined;
	if (masterPasswordStrength(password).id >= MIN_RECOMMENDED_STRENGTH) return undefined;
	return "This password is weak. Anyone who gets your vault file could crack it offline.";
}
