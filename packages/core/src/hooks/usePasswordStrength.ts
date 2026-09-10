import { useEffect, useState } from "react";
import {
	masterPasswordWarning,
	passwordStrength,
	preloadPasswordStrength,
	type StrengthScore,
} from "../util/password-strength";

/** zxcvbn score for `password`, or null until the estimator has scored it. */
export function usePasswordStrength(password: string): StrengthScore | null {
	const [score, setScore] = useState<StrengthScore | null>(null);

	// Warm the dictionary fetch on mount, so the first keystroke already has a score.
	useEffect(preloadPasswordStrength, []);

	useEffect(() => {
		if (!password) {
			setScore(null);
			return;
		}
		let live = true;
		void passwordStrength(password).then((s) => {
			if (live) setScore(s);
		});
		return () => {
			live = false;
		};
	}, [password]);

	return score;
}

/** The weak-master-password advisory, once the estimator has scored the password. */
export function useMasterPasswordWarning(password: string): string | undefined {
	return masterPasswordWarning(password, usePasswordStrength(password));
}
