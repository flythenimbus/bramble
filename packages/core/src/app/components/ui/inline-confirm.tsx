import { Trans } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "./button";
import { cn } from "./utils";

export interface InlineConfirmProps {
	/** The resting control. Its click calls `arm` to ask. */
	trigger: (arm: () => void) => ReactNode;
	/** A short question beside the buttons, such as "Delete this entry?". */
	prompt?: ReactNode;
	confirmLabel: ReactNode;
	/** Shown on the confirm button while `onConfirm` runs. */
	busyLabel?: ReactNode;
	onConfirm: () => unknown;
	/** What confirming does, shown under the buttons while asking. */
	note?: ReactNode;
	/** Outline for what can be undone (a disconnect), filled for what can't (a delete). */
	variant?: "destructive" | "destructiveOutline";
	/** `stacked` puts the prompt above two equal buttons, for a narrow menu. */
	layout?: "inline" | "stacked";
	/** Controlled arming, for a caller that rearranges around the question. */
	armed?: boolean;
	onArmedChange?: (armed: boolean) => void;
	/** Takes a failure instead of showing it here, for a caller with its own error line. */
	onError?: (error: unknown) => void;
	className?: string;
}

/**
 * A destructive action that asks once, in place: the trigger is swapped for Cancel and a
 * confirm where it sat, so the question appears where the user is already looking. Escape or
 * Cancel backs out. For an action that needs reading first or an input, use ConfirmDialog.
 */
export function InlineConfirm({
	trigger,
	prompt,
	confirmLabel,
	busyLabel,
	onConfirm,
	note,
	variant = "destructive",
	layout = "inline",
	armed: armedProp,
	onArmedChange,
	onError,
	className,
}: InlineConfirmProps) {
	const [armedState, setArmedState] = useState(false);
	const armed = armedProp ?? armedState;
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);
	// Confirming often unmounts the whole thing (the entry it deleted is gone), and a state
	// update after that is a warning at best.
	const mounted = useRef(true);
	useEffect(
		() => () => {
			mounted.current = false;
		},
		[],
	);

	const setArmed = (next: boolean) => {
		if (armedProp === undefined) setArmedState(next);
		onArmedChange?.(next);
		if (!next) setError(null);
	};

	// Focus lands on Cancel, so a stray Enter backs out rather than destroys.
	useEffect(() => {
		if (armed) cancelRef.current?.focus();
	}, [armed]);

	if (!armed) return <>{trigger(() => setArmed(true))}</>;

	const confirm = async () => {
		setBusy(true);
		setError(null);
		try {
			await onConfirm();
			if (mounted.current) setArmed(false);
		} catch (err) {
			if (onError) onError(err);
			else if (mounted.current) setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (mounted.current) setBusy(false);
		}
	};

	const buttons = (
		<>
			<Button
				ref={cancelRef}
				variant="secondary"
				size="sm"
				disabled={busy}
				onClick={() => setArmed(false)}
				className={cn(layout === "stacked" && "flex-1")}
			>
				<Trans>Cancel</Trans>
			</Button>
			<Button
				variant={variant}
				size="sm"
				disabled={busy}
				onClick={() => void confirm()}
				className={cn(layout === "stacked" && "flex-1")}
			>
				{busy ? (busyLabel ?? confirmLabel) : confirmLabel}
			</Button>
		</>
	);

	return (
		<div
			role="group"
			className={cn(layout === "stacked" ? "space-y-2" : "inline-flex flex-col gap-1", className)}
			onKeyDown={(e) => {
				if (e.key === "Escape" && !busy) {
					e.stopPropagation();
					setArmed(false);
				}
			}}
		>
			{layout === "stacked" ? (
				<>
					{prompt && <p className="text-xs text-foreground">{prompt}</p>}
					<div className="flex items-center gap-2">{buttons}</div>
				</>
			) : (
				<span className="inline-flex flex-wrap items-center justify-end gap-2">
					{prompt && <span className="text-xs text-foreground">{prompt}</span>}
					{buttons}
				</span>
			)}
			{error && <p className="text-xs text-destructive">{error}</p>}
			{note && <p className="text-xs text-muted-foreground">{note}</p>}
		</div>
	);
}
