import { registerPlugin } from "@capacitor/core";

// The system rating prompt (ios/App/App/AppReview.swift). StoreKit owns the frequency policy:
// at most three prompts per year, none once the current version has been rated, and none at all
// in a TestFlight build, which is why the sheet can only be seen in a debug or App Store build.
// Our side only picks the moment (@core/app/review-nudge).
interface AppReviewPlugin {
	requestReview(): Promise<void>;
}

const Native = registerPlugin<AppReviewPlugin>("AppReview");

/** Ask iOS to consider showing its rating prompt. Resolving means the request was made, never
 * that anything was shown. Failures are swallowed: an unasked-for prompt failing to appear is
 * not something to put in front of someone who was busy doing something else. */
export async function requestStoreReview(): Promise<void> {
	await Native.requestReview().catch(() => {});
}
