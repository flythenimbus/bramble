/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ISSUES_URL, STORE_REVIEW_URL } from "../review-nudge";
import { ReviewNudgeCard } from "./ReviewNudgeCard";

// The card is the only place the policy's decision becomes something clickable, and what it does
// with a click is the part that cannot be checked in review-nudge.test.ts: a "Leave a review" that
// recorded a dismissal would keep asking someone who already rated it, and a link with no href
// would look like a dead button.

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

afterEach(cleanup);

const reviewUrl = STORE_REVIEW_URL.chromium as string;

function mount() {
	const onRated = vi.fn();
	const onDismiss = vi.fn();
	render(
		<I18nProvider i18n={i18n}>
			<ReviewNudgeCard nudge={{ reviewUrl, onRated, onDismiss }} />
		</I18nProvider>,
	);
	return { onRated, onDismiss };
}

const link = (name: RegExp) => screen.getByRole("link", { name });

describe("ReviewNudgeCard", () => {
	it("sends each link where it claims to, in a new tab", () => {
		mount();
		const review = link(/leave a review/i);
		expect(review).toHaveProperty("href", reviewUrl);
		expect(review.getAttribute("target")).toBe("_blank");
		// noreferrer as well as noopener: the store has no business being told which page sent us.
		expect(review.getAttribute("rel")).toContain("noreferrer");
		expect(link(/report an issue/i)).toHaveProperty("href", ISSUES_URL);
	});

	it("records a rating only for the review link", () => {
		const h = mount();
		fireEvent.click(link(/leave a review/i));
		expect(h.onRated).toHaveBeenCalledOnce();
		expect(h.onDismiss).not.toHaveBeenCalled();
	});

	it("spends the ask, without claiming a rating, for the issue link and the close button", () => {
		const h = mount();
		fireEvent.click(link(/report an issue/i));
		fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
		expect(h.onDismiss).toHaveBeenCalledTimes(2);
		expect(h.onRated).not.toHaveBeenCalled();
	});

	it("offers both answers at once rather than branching on sentiment", () => {
		// The anti-pattern this guards against is a "do you like it?" gate that only shows the
		// store link to people who say yes. Both links are present on first render, always.
		mount();
		expect(screen.getAllByRole("link")).toHaveLength(2);
	});
});
