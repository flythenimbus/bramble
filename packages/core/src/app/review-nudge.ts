// When to ask for a store review, and where to send someone who says yes.
//
// Every number the decision rests on lives in REVIEW_NUDGE below, and `shouldAskForReview` takes
// the tuning as an argument, so changing the policy is editing one object rather than reading the
// logic. Tests pass their own.
//
// Local by construction: the decision reads counters this device wrote and nothing else. The
// breach check is the app's only network egress (usePrefs), and a rating prompt is not worth
// changing that, so nothing here touches the network until the user clicks the link themselves.

import type { Target } from "../flags";

const DAY_MS = 86_400_000;

export interface ReviewNudgeTuning {
	/** Minimum install age. Someone still deciding whether to keep it has no opinion to give yet. */
	minInstallAgeDays: number;
	/** Minimum unlocked sessions, i.e. the app is actually in use rather than merely installed. */
	minSessions: number;
	/** Minimum entries, so we ask the owner of a real vault rather than someone mid-trial. */
	minEntries: number;
	/** Asks over the lifetime of the install, dismissals included. Two is the whole budget. */
	maxAsks: number;
	/** Quiet period between asks. */
	daysBetweenAsks: number;
}

/** The shipped policy. Tweak here; nothing else reads a literal. */
export const REVIEW_NUDGE: ReviewNudgeTuning = {
	minInstallAgeDays: 14,
	minSessions: 10,
	minEntries: 3,
	maxAsks: 2,
	daysBetweenAsks: 90,
};

export interface ReviewNudgeState {
	/** When this device started counting. On an install predating the feature that is the first
	 * run after upgrading, not the true install date, which only ever delays the first ask. */
	installedAt: number;
	/** Unlocked sessions seen (popup opens on the extension, lock->unlock transitions elsewhere). */
	sessions: number;
	/** Asks spent, whatever the answer was. */
	asks: number;
	lastAskedAt?: number;
	/** They went to the store. Ends it for good: there is nothing left to ask for. */
	rated: boolean;
}

export function freshReviewNudgeState(now: number): ReviewNudgeState {
	return { installedAt: now, sessions: 0, asks: 0, rated: false };
}

/** Field by field, like normalizeGeneratorSettings: a stored object may come from an older or a
 * hand-edited build, and a bad `installedAt` here means asking someone on day one. */
export function normalizeReviewNudgeState(raw: unknown, now: number): ReviewNudgeState {
	if (!raw || typeof raw !== "object") return freshReviewNudgeState(now);
	const r = raw as Record<string, unknown>;
	// A timestamp in the future would make the install look infinitely young, so it is clamped
	// rather than trusted; a device whose clock was wrong once should still get asked eventually.
	const installedAt =
		typeof r.installedAt === "number" && r.installedAt > 0 ? Math.min(r.installedAt, now) : now;
	const count = (v: unknown) => (typeof v === "number" && v >= 0 ? Math.floor(v) : 0);
	return {
		installedAt,
		sessions: count(r.sessions),
		asks: count(r.asks),
		lastAskedAt: typeof r.lastAskedAt === "number" ? r.lastAskedAt : undefined,
		rated: r.rated === true,
	};
}

export interface ReviewNudgeSignals {
	now: number;
	/** Live entries in the open vault. */
	entries: number;
}

export function countSession(state: ReviewNudgeState): ReviewNudgeState {
	return { ...state, sessions: state.sessions + 1 };
}

export function recordAsk(state: ReviewNudgeState, now: number): ReviewNudgeState {
	return { ...state, asks: state.asks + 1, lastAskedAt: now };
}

export function recordRated(state: ReviewNudgeState, now: number): ReviewNudgeState {
	return { ...recordAsk(state, now), rated: true };
}

/**
 * Counters that clear every gate this module controls: old enough, used enough, nothing asked yet.
 *
 * For the dev panel, so testing the ask does not mean waiting a fortnight or editing the tuning and
 * rebuilding. Derived from the tuning rather than hardcoded, so retuning cannot leave it arming a
 * state that no longer qualifies. The entries gate is a fact about the vault and is deliberately
 * NOT faked: the point is to see the real card under the real policy, one clock short.
 */
export function qualifyingReviewNudgeState(
	now: number,
	tuning: ReviewNudgeTuning = REVIEW_NUDGE,
): ReviewNudgeState {
	return {
		installedAt: now - (tuning.minInstallAgeDays + 1) * DAY_MS,
		sessions: tuning.minSessions,
		asks: 0,
		rated: false,
	};
}

/**
 * Nothing more will ever be asked, whatever happens next. Distinct from `shouldAskForReview`
 * returning false, which is usually just "not yet": this one is permanent, and it is what lets the
 * session counter stop writing to storage on every single open once the budget is spent.
 */
export function isReviewNudgeDone(
	state: ReviewNudgeState,
	tuning: ReviewNudgeTuning = REVIEW_NUDGE,
): boolean {
	return state.rated || state.asks >= tuning.maxAsks;
}

/** The whole policy. Pure, so the decision is testable without a vault or a platform. */
export function shouldAskForReview(
	state: ReviewNudgeState,
	signals: ReviewNudgeSignals,
	tuning: ReviewNudgeTuning = REVIEW_NUDGE,
): boolean {
	if (isReviewNudgeDone(state, tuning)) return false;
	if (signals.now - state.installedAt < tuning.minInstallAgeDays * DAY_MS) return false;
	if (state.sessions < tuning.minSessions) return false;
	if (signals.entries < tuning.minEntries) return false;
	if (
		state.lastAskedAt !== undefined &&
		signals.now - state.lastAskedAt < tuning.daysBetweenAsks * DAY_MS
	)
		return false;
	return true;
}

/**
 * Where "leave a review" goes, per target. Presence here IS the capability, which is why there is
 * no matching entry in CAPABILITIES: a target with no public listing has no URL, and a second flag
 * saying so is one more thing to forget when a listing appears or moves. Android ships as a GitHub
 * APK and desktop as a download, so neither is listed.
 */
export const STORE_REVIEW_URL: Partial<Record<Target, string>> = {
	chromium:
		"https://chromewebstore.google.com/detail/bramble/kmokhdhoggbdcgoepifeckhgbfakaknm/reviews",
	firefox: "https://addons.mozilla.org/firefox/addon/bramble/reviews/",
	// `?action=write-review` opens the App Store with the compose sheet already up. This is for the
	// Settings row only. A nudge on iOS fires the OS prompt instead (shell.requestStoreReview),
	// because Apple's HIG forbids putting that prompt behind a button.
	ios: "https://apps.apple.com/app/id6783071787?action=write-review",
};

/** Where "report an issue" goes. Offered beside the review ask so someone with a complaint has
 * somewhere better to put it than a one-star review. */
export const ISSUES_URL = "https://github.com/flythenimbus/bramble/issues";

export function storeReviewUrl(target: Target): string | undefined {
	return STORE_REVIEW_URL[target];
}
