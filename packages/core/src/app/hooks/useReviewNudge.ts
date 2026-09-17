import { useEffect, useRef } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { usePrefs } from "../../hooks/usePrefs";
import {
	countSession,
	isReviewNudgeDone,
	recordAsk,
	recordRated,
	shouldAskForReview,
	storeReviewUrl,
} from "../review-nudge";

export interface ReviewNudge {
	/** Where "leave a review" goes for this target. */
	reviewUrl: string;
	/** They are on their way to the store. Ends the asking for good. */
	onRated(): void;
	/** "Not now", or the close button. Spends one ask and starts the quiet period. */
	onDismiss(): void;
}

/**
 * The store-review ask: counts usage, and returns card state on the one turn it decides to ask.
 *
 * Null covers every other case, including all of iOS. There the OS has a prompt of its own and
 * Apple's HIG forbids putting it behind a button, so this fires it directly and shows no card;
 * `shell.requestStoreReview` is absent everywhere else. Null also covers a target with no public
 * listing (Android, desktop), which has no URL in the first place.
 *
 * `entryCount` is the open vault's size, one of the signals the policy reads (review-nudge.ts).
 */
export function useReviewNudge(entryCount: number): ReviewNudge | null {
	const { target, shell } = usePlatform();
	const { prefs, loaded, update } = usePrefs();
	const state = prefs.reviewNudge;
	const reviewUrl = storeReviewUrl(target);
	const native = shell.requestStoreReview;

	// Counting is over once no further ask can happen, and on a target with nowhere to send anyone.
	// Without this the extension would write a storage key on every popup open for the life of the
	// install, to increment a number nothing would ever read again.
	const counting = reviewUrl !== undefined && !isReviewNudgeDone(state);

	// One count per unlocked session. The extension's popup is a fresh document per open, so that
	// is once per open; a long-lived mobile window counts once per mount. Guarded by a ref rather
	// than by the stored number, which this effect is itself about to change.
	const counted = useRef(false);
	useEffect(() => {
		if (!loaded || !counting || counted.current) return;
		counted.current = true;
		void update("reviewNudge", countSession(state));
	}, [loaded, counting, state, update]);

	const shouldAsk = loaded && shouldAskForReview(state, { now: Date.now(), entries: entryCount });

	// iOS: spend the ask, then hand it to StoreKit, which decides whether anything is shown. The
	// ask is recorded either way, because we are never told.
	const askedNatively = useRef(false);
	useEffect(() => {
		if (!native || !shouldAsk || askedNatively.current) return;
		askedNatively.current = true;
		void update("reviewNudge", recordAsk(state, Date.now()));
		void shell.requestStoreReview?.();
	}, [native, shouldAsk, state, update, shell]);

	if (!reviewUrl || native || !shouldAsk) return null;
	return {
		reviewUrl,
		onRated: () => void update("reviewNudge", recordRated(state, Date.now())),
		onDismiss: () => void update("reviewNudge", recordAsk(state, Date.now())),
	};
}
