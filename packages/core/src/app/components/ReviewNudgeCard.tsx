import { Trans, useLingui } from "@lingui/react/macro";
import { Star, X } from "lucide-react";
import type { ReviewNudge } from "../hooks/useReviewNudge";
import { ISSUES_URL } from "../review-nudge";
import { Button, buttonClasses } from "./ui/button";

/**
 * The store-review ask: an inline card under the vault list, never a dialog.
 *
 * Both links are offered flat, with no question in front of them deciding which one a person is
 * shown. Routing the happy answers to the store and the unhappy ones somewhere quieter is review
 * manipulation however politely it is worded, and someone with a complaint deserves the issue
 * tracker offered to them rather than held back.
 *
 * Rendered only on the turn useReviewNudge says to ask; see review-nudge.ts for when that is.
 */
export function ReviewNudgeCard({ nudge }: { nudge: ReviewNudge }) {
	const { t } = useLingui();
	return (
		<div className="relative shrink-0 mt-3 rounded-lg border border-border bg-muted/40 p-3 space-y-2">
			<Button
				variant="ghost"
				size="none"
				onClick={nudge.onDismiss}
				aria-label={t`Dismiss`}
				className="absolute top-1.5 right-1.5 p-1.5 text-muted-foreground"
			>
				<X className="w-3.5 h-3.5" />
			</Button>
			<p className="flex items-center gap-1.5 pr-6 text-sm">
				<Star className="w-4 h-4 shrink-0 text-primary" />
				<Trans>Say something nice?</Trans>
			</p>
			{/* "Or something honest" is load bearing rather than a joke: an ask that only wants praise
			    is the manipulative version of this card, and the second button is what makes it true.
			    pr-6 keeps the text clear of the close button. */}
			<p className="pr-6 text-xs text-muted-foreground">
				<Trans>Or something honest, either works. Reviews are how people find Bramble.</Trans>
			</p>
			<div className="flex flex-wrap items-center gap-2">
				{/* Real anchors, not buttons: the extension opens these in a new tab, and the click
				    that records the outcome is the same one that navigates. */}
				<a
					href={nudge.reviewUrl}
					target="_blank"
					rel="noreferrer noopener"
					onClick={nudge.onRated}
					className={buttonClasses({ variant: "primary", size: "sm" })}
				>
					<Trans>Leave a review</Trans>
				</a>
				<a
					href={ISSUES_URL}
					target="_blank"
					rel="noreferrer noopener"
					// Counts as the ask being spent, not as a rating: they engaged, and 90 days from
					// now is a perfectly reasonable time to ask again.
					onClick={nudge.onDismiss}
					className={buttonClasses({ variant: "secondary", size: "sm" })}
				>
					<Trans>Report an issue</Trans>
				</a>
			</div>
		</div>
	);
}
