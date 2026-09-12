import { describe, expect, it } from "vitest";
import type { Target } from "../flags";
import {
	countSession,
	freshReviewNudgeState,
	isReviewNudgeDone,
	normalizeReviewNudgeState,
	qualifyingReviewNudgeState,
	REVIEW_NUDGE,
	type ReviewNudgeState,
	recordAsk,
	recordRated,
	shouldAskForReview,
	storeReviewUrl,
} from "./review-nudge";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

/** A state that clears every gate, so each test can spoil exactly one. The shipped helper the dev
 * panel arms with, which is worth exercising here rather than reimplementing beside it. */
function qualifying(patch: Partial<ReviewNudgeState> = {}): ReviewNudgeState {
	return { ...qualifyingReviewNudgeState(NOW), ...patch };
}

const signals = (patch: Partial<{ now: number; entries: number }> = {}) => ({
	now: NOW,
	entries: REVIEW_NUDGE.minEntries,
	...patch,
});

describe("shouldAskForReview", () => {
	it("asks once every gate is cleared", () => {
		expect(shouldAskForReview(qualifying(), signals())).toBe(true);
	});

	it("stays quiet on a young install however heavily it is used", () => {
		const young = qualifying({
			installedAt: NOW - (REVIEW_NUDGE.minInstallAgeDays - 1) * DAY,
			sessions: 1000,
		});
		expect(shouldAskForReview(young, signals({ entries: 500 }))).toBe(false);
	});

	it("stays quiet until the app has actually been used", () => {
		const idle = qualifying({ sessions: REVIEW_NUDGE.minSessions - 1 });
		expect(shouldAskForReview(idle, signals())).toBe(false);
	});

	it("stays quiet on a near-empty vault", () => {
		expect(
			shouldAskForReview(qualifying(), signals({ entries: REVIEW_NUDGE.minEntries - 1 })),
		).toBe(false);
	});

	it("honours the quiet period after an ask, then asks again", () => {
		const asked = recordAsk(qualifying(), NOW);
		const tooSoon = NOW + (REVIEW_NUDGE.daysBetweenAsks - 1) * DAY;
		expect(shouldAskForReview(asked, signals({ now: tooSoon }))).toBe(false);
		const later = NOW + (REVIEW_NUDGE.daysBetweenAsks + 1) * DAY;
		expect(shouldAskForReview(asked, signals({ now: later }))).toBe(true);
	});

	it("spends its budget and then never asks again", () => {
		let state = qualifying();
		let now = NOW;
		for (let i = 0; i < REVIEW_NUDGE.maxAsks; i++) {
			expect(shouldAskForReview(state, signals({ now }))).toBe(true);
			state = recordAsk(state, now);
			now += (REVIEW_NUDGE.daysBetweenAsks + 1) * DAY;
		}
		// Past the quiet period, past every other gate, and still done: maxAsks is a hard stop.
		expect(shouldAskForReview(state, signals({ now }))).toBe(false);
		expect(shouldAskForReview(state, signals({ now: now + 3650 * DAY }))).toBe(false);
	});

	it("never asks someone who already went to the store", () => {
		const rated = recordRated(qualifying(), NOW);
		const later = NOW + 3650 * DAY;
		expect(shouldAskForReview(rated, signals({ now: later }))).toBe(false);
	});

	it("takes its numbers from the tuning it is given", () => {
		// The point of the knobs: the same state reads differently under a different policy.
		const state = qualifying({ sessions: 3 });
		expect(shouldAskForReview(state, signals())).toBe(false);
		expect(shouldAskForReview(state, signals(), { ...REVIEW_NUDGE, minSessions: 3 })).toBe(true);
	});
});

describe("qualifyingReviewNudgeState", () => {
	it("arms a state the policy accepts, and keeps doing so after a retune", () => {
		// What the dev panel's "Arm review ask" writes. Derived from the tuning, so lowering or
		// raising a threshold cannot leave it arming something that no longer qualifies.
		const tuning = { ...REVIEW_NUDGE, minInstallAgeDays: 40, minSessions: 99 };
		for (const t of [REVIEW_NUDGE, tuning]) {
			const armed = qualifyingReviewNudgeState(NOW, t);
			expect(shouldAskForReview(armed, { now: NOW, entries: t.minEntries }, t)).toBe(true);
		}
	});

	it("leaves the entries gate alone, since that is a fact about the vault", () => {
		const armed = qualifyingReviewNudgeState(NOW);
		expect(shouldAskForReview(armed, { now: NOW, entries: REVIEW_NUDGE.minEntries - 1 })).toBe(
			false,
		);
	});
});

describe("isReviewNudgeDone", () => {
	it("separates 'not yet' from 'never again', which is what stops the counter writing", () => {
		// Every gate failing is still not done: this install just has some growing up to do.
		expect(isReviewNudgeDone(freshReviewNudgeState(NOW))).toBe(false);
		expect(isReviewNudgeDone(recordRated(qualifying(), NOW))).toBe(true);
		expect(isReviewNudgeDone(qualifying({ asks: REVIEW_NUDGE.maxAsks }))).toBe(true);
	});
});

describe("state transitions", () => {
	it("counts a session without spending an ask", () => {
		const state = countSession(freshReviewNudgeState(NOW));
		expect(state.sessions).toBe(1);
		expect(state.asks).toBe(0);
	});

	it("records the ask a rating implies, so a store trip also closes the budget", () => {
		const rated = recordRated(freshReviewNudgeState(NOW), NOW);
		expect(rated).toMatchObject({ rated: true, asks: 1, lastAskedAt: NOW });
	});
});

describe("normalizeReviewNudgeState", () => {
	it("starts the clock now for an install that predates the feature", () => {
		expect(normalizeReviewNudgeState(undefined, NOW)).toEqual(freshReviewNudgeState(NOW));
	});

	it("refuses a future installedAt rather than making the install look infinitely young", () => {
		const skewed = normalizeReviewNudgeState({ installedAt: NOW + 3650 * DAY }, NOW);
		expect(skewed.installedAt).toBe(NOW);
	});

	it("drops junk from a hand-edited or older build", () => {
		const state = normalizeReviewNudgeState(
			{ installedAt: "yesterday", sessions: -5, asks: 2.7, lastAskedAt: {}, rated: "yes" },
			NOW,
		);
		expect(state).toEqual({
			installedAt: NOW,
			sessions: 0,
			asks: 2,
			lastAskedAt: undefined,
			rated: false,
		});
	});

	it("preserves a good value", () => {
		const stored = {
			installedAt: NOW - 30 * DAY,
			sessions: 12,
			asks: 1,
			lastAskedAt: NOW,
			rated: false,
		};
		expect(normalizeReviewNudgeState(stored, NOW)).toEqual(stored);
	});
});

describe("storeReviewUrl", () => {
	it("has a listing for every published target and none for the rest", () => {
		const published: Target[] = ["chromium", "firefox", "ios"];
		for (const target of published) expect(storeReviewUrl(target)).toMatch(/^https:\/\//);
		// Android is a GitHub APK (no Play listing) and desktop is a download; neither has reviews.
		expect(storeReviewUrl("android")).toBeUndefined();
		expect(storeReviewUrl("desktop")).toBeUndefined();
	});

	it("points iOS at the compose sheet, since that link is the button path", () => {
		expect(storeReviewUrl("ios")).toContain("action=write-review");
	});
});
