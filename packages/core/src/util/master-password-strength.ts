import { passwordStrength } from "check-password-strength";

// Minimum strength `id` we accept for a master password. `check-password-strength`
// scores 0 ("Too weak") · 1 ("Weak") · 2 ("Medium") · 3 ("Strong"); 2 is the
// usual industry floor for a passphrase that's plausibly safe against an
// offline Argon2id attack once the vault file syncs to a cloud folder. There
// is no recovery — a weak master password is a permanent loss waiting to
// happen.
const MIN_MASTER_PASSWORD_STRENGTH = 2;

export interface MasterPasswordStrength {
	id: number;
	label: string;
	// True when the score meets MIN_MASTER_PASSWORD_STRENGTH. Both setup and
	// rotation use this as the validator gate.
	acceptable: boolean;
}

export function masterPasswordStrength(password: string): MasterPasswordStrength {
	const s = passwordStrength(password);
	return { id: s.id, label: s.value, acceptable: s.id >= MIN_MASTER_PASSWORD_STRENGTH };
}

// Form-validator message returned when a candidate master password is too
// weak. Returns undefined for an acceptable password.
export function masterPasswordRejectionMessage(password: string): string | undefined {
	if (!password) return undefined;
	const s = masterPasswordStrength(password);
	if (s.acceptable) return undefined;
	return `${s.label} — choose a longer or more varied passphrase`;
}
