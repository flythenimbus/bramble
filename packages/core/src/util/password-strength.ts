import type { ZXCVBNResult } from "zxcvbn";

// Master-password policy: a hard length floor (rejected outright), then inform
// rather than forbid: weak-but-usable raises a non-blocking warning.

const MIN_MASTER_PASSWORD_LENGTH = 8;
// zxcvbn scores by guess count: 0 too guessable … 4 very unguessable. 3 is its
// "safely unguessable" tier, so we warn below that.
export const MIN_RECOMMENDED_SCORE = 3;

/** zxcvbn's 0-4 strength score. */
export type StrengthScore = 0 | 1 | 2 | 3 | 4;

// zxcvbn's matchers are superlinear in length; Dropbox's own guidance is to cap the
// input. Anything past this only ever adds strength, so the truncated score is safe.
const MAX_SCORED_LENGTH = 100;

// The frequency lists are ~800 kB, so the estimator is fetched on demand and cached
// rather than sitting in the popup's startup bundle.
let estimator: Promise<(password: string) => ZXCVBNResult> | undefined;

function loadEstimator() {
	estimator ??= import("zxcvbn").then((m) => m.default);
	return estimator;
}

/** Starts the dictionary fetch so a score is ready by the time someone stops typing. */
export function preloadPasswordStrength(): void {
	void loadEstimator();
}

/** Strength score for a candidate password. Async because the estimator loads on demand. */
export async function passwordStrength(password: string): Promise<StrengthScore> {
	const zxcvbn = await loadEstimator();
	return zxcvbn(password.slice(0, MAX_SCORED_LENGTH)).score as StrengthScore;
}

/** Blocking validator: returns a message only for too-short input. Empty is left to the form's required. */
export function masterPasswordHardError(password: string): string | undefined {
	if (!password) return undefined;
	if (password.length < MIN_MASTER_PASSWORD_LENGTH) {
		return `Use at least ${MIN_MASTER_PASSWORD_LENGTH} characters.`;
	}
	return undefined;
}

/** Non-blocking advisory for a password that clears the floor but is still weak.
 * A null score (estimator still loading) warns about nothing. */
export function masterPasswordWarning(
	password: string,
	score: StrengthScore | null,
): string | undefined {
	if (!password || masterPasswordHardError(password)) return undefined;
	if (score === null || score >= MIN_RECOMMENDED_SCORE) return undefined;
	return "This password is weak. Anyone who gets your vault file could crack it offline.";
}
