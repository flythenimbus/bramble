// The flag panel, opened by a shortcut nobody will hit by accident.
//
// Its reason to exist is testing a SIGNED build: the flags are baked at build time, so without
// this, trying a gated feature on the artefact you are about to ship means rebuilding it, and then
// you are no longer testing the artefact you tested. The same argument brings in the odd action
// that is not a flag at all, where the thing standing between you and a feature is persisted state
// rather than a gate.
//
// Deliberately plain and unlocalised. It is a developer surface, and translating it would put
// fourteen strings a user never sees in front of five translators.

import { useEffect, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import {
	BAKED,
	clearOverrides,
	DEV_FLAGS_KEY,
	flagValue,
	hydrateOverrides,
	OVERRIDABLE,
	type OverridableFlag,
	setOverride,
} from "../../dev-flags";
import { flags } from "../../flags";
import { PREF_REVIEW_NUDGE } from "../../hooks/usePrefs";
import { setDevFlagsOpener } from "../dev-flags-open";
import { qualifyingReviewNudgeState, REVIEW_NUDGE } from "../review-nudge";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";

/** Cmd/Ctrl + Shift + Alt + F. Matched on `code`, because Alt rewrites `key` on macOS. */
function isShortcut(e: KeyboardEvent): boolean {
	return (e.metaKey || e.ctrlKey) && e.shiftKey && e.altKey && e.code === "KeyF";
}

export function DevFlagsModal() {
	const { storage } = usePlatform();
	const [open, setOpen] = useState(false);
	// Local mirror so ticking a box re-renders; the store itself is the source of truth.
	const [, bump] = useState(0);
	// What the last review-ask action did. A storage write is invisible, and a dev action that
	// looks identical whether it worked or threw is worse than no action at all.
	const [reviewNote, setReviewNote] = useState<string | null>(null);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!isShortcut(e)) return;
			e.preventDefault();
			setOpen((was) => !was);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// The touch way in (Settings -> About), for a phone with no keyboard to press the shortcut on.
	useEffect(() => {
		setDevFlagsOpener(() => setOpen(true));
		return () => setDevFlagsOpener(null);
	}, []);

	const persist = (next: Record<string, boolean>) => {
		bump((n) => n + 1);
		// Best effort. A failed write costs the override on the next reload, not correctness.
		void storage.setMeta(DEV_FLAGS_KEY, next);
	};

	// Written straight to storage rather than through usePrefs: this panel is mounted above
	// PrefsProvider (App.tsx) so it works on the unlock screen, and has no prefs context to call.
	// Nothing re-reads prefs on a storage change, so the view has to be reopened either way.
	const reviewAction = (label: string, write: () => Promise<void>) => () => {
		setReviewNote(null);
		write().then(
			() => setReviewNote(label),
			(e: unknown) => setReviewNote(`failed: ${String(e)}`),
		);
	};
	const armReview = reviewAction("Armed. Close the popup and reopen it on the vault list.", () =>
		storage.setMeta(PREF_REVIEW_NUDGE, qualifyingReviewNudgeState(Date.now())),
	);
	const resetReview = reviewAction("Cleared. The counters start again from now.", () =>
		storage.removeMeta(PREF_REVIEW_NUDGE),
	);

	if (!open) return null;

	return (
		<Modal
			open
			onClose={() => {
				setReviewNote(null);
				setOpen(false);
			}}
			className="max-w-md"
		>
			<div className="p-5 space-y-4">
				<div>
					<h2 className="text-base font-medium">Feature flags</h2>
					<p className="text-xs text-muted-foreground mt-1">
						Overrides for this device, kept until you clear them. For testing a build without
						rebuilding it.
					</p>
				</div>

				<div className="space-y-2">
					{OVERRIDABLE.map((name: OverridableFlag) => (
						<label key={name} className="flex items-start gap-2 text-xs">
							<input
								type="checkbox"
								className="mt-0.5"
								checked={flagValue(name)}
								onChange={(e) =>
									persist(setOverride(name, e.target.checked) as Record<string, boolean>)
								}
							/>
							<span>
								<span className="font-mono">{name}</span>
								{flagValue(name) !== flags[name] && (
									<span className="ml-2 text-primary">overridden</span>
								)}
							</span>
						</label>
					))}
				</div>

				{/* Shown rather than hidden, so it is obvious these exist and why they are not here to
				    be flipped: core-rust compiles the same values in, and moving one side only would
				    be a disagreement about a security rule. */}
				<div className="space-y-1 border-t border-border pt-3">
					<p className="text-xs text-muted-foreground">
						Compiled into the Rust core as well, so they cannot be changed here:
					</p>
					{BAKED.map((name) => (
						<p key={name} className="text-xs font-mono text-muted-foreground">
							{name}: {String(flags[name])}
						</p>
					))}
				</div>

				{/* Not a flag: "show the review ask" is persisted state, and flags.json is compiled
				    into core-rust key by key, so a UI-only entry there would put a review-prompt
				    constant in the crypto core. Two actions rather than a toggle for the same reason
				    the state is not a boolean - forcing the card on would bypass the policy this is
				    meant to exercise. See docs/store-reviews.md. */}
				<div className="space-y-2 border-t border-border pt-3">
					<p className="text-xs text-muted-foreground">
						Store-review ask. <span className="font-mono">Arm</span> sets the counters so the next
						open qualifies. Two things it cannot do for you: the vault needs{" "}
						{REVIEW_NUDGE.minEntries} entries, and the card only renders on the vault list, so a
						popup that reopens onto Settings will not show it. On iOS this fires the OS prompt
						instead of a card.
					</p>
					{reviewNote && <p className="text-xs text-primary">{reviewNote}</p>}
					<div className="flex gap-2">
						<Button variant="secondary" size="sm" onClick={armReview}>
							Arm review ask
						</Button>
						<Button variant="secondary" size="sm" onClick={resetReview}>
							Reset review ask
						</Button>
					</div>
				</div>

				<div className="flex justify-end gap-2">
					<Button
						variant="secondary"
						size="sm"
						onClick={() => persist(clearOverrides() as Record<string, boolean>)}
					>
						Reset
					</Button>
					<Button size="sm" onClick={() => setOpen(false)}>
						Close
					</Button>
				</div>
			</div>
		</Modal>
	);
}

/** Load persisted overrides once at boot, before anything reads a gated flag. */
export function useHydrateDevFlags(): void {
	const { storage } = usePlatform();
	useEffect(() => {
		void storage
			.getMeta<Record<string, boolean>>(DEV_FLAGS_KEY)
			.then((stored) => {
				if (stored) hydrateOverrides(stored);
			})
			.catch(() => {});
	}, [storage]);
}
