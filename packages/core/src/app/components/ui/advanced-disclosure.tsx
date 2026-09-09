import { Trans } from "@lingui/react/macro";
import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "./button";
import { cn } from "./utils";

interface AdvancedDisclosureProps {
	children: ReactNode;
	/**
	 * Controlled open state, for a caller that opens it on the user's behalf. The backup form
	 * does: a provider whose endpoint it cannot fill in starts expanded, because the field the
	 * user has to complete is inside. Omit both props to let the disclosure own its state.
	 */
	open?: boolean;
	onOpenChange?: (next: boolean) => void;
	/** Extra classes on the body, since callers space their rows differently. */
	className?: string;
}

/**
 * The "Advanced" reveal used across the app: settings that are real but that most people should
 * not have to read past.
 *
 * One component rather than the three near-copies this replaces, which had already drifted: two
 * had a press affordance and one did not. The label is fixed on purpose, so every one of these
 * reads the same and a user learns the control once.
 */
export function AdvancedDisclosure({
	children,
	open,
	onOpenChange,
	className,
}: AdvancedDisclosureProps) {
	const [ownOpen, setOwnOpen] = useState(false);
	const isOpen = open ?? ownOpen;
	const toggle = () => {
		const next = !isOpen;
		// Both are called: a controlled caller hears about it, and an uncontrolled one still works
		// if it passed only a change handler to observe the toggle.
		if (open === undefined) setOwnOpen(next);
		onOpenChange?.(next);
	};

	return (
		<div>
			<Button
				variant="link"
				size="none"
				onClick={toggle}
				className="gap-1.5 text-xs active:scale-[0.98]"
				aria-expanded={isOpen}
			>
				{isOpen ? (
					<ChevronDown className="w-3.5 h-3.5" />
				) : (
					<ChevronRight className="w-3.5 h-3.5" />
				)}
				<Trans>Advanced</Trans>
			</Button>
			{isOpen && (
				<div className={cn("mt-3 space-y-4 pl-4 border-l border-border/40", className)}>
					{children}
				</div>
			)}
		</div>
	);
}
