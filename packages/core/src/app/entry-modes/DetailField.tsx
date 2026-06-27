import { useLingui } from "@lingui/react/macro";
import { Check, Copy } from "lucide-react";
import type { ReactNode } from "react";

interface DetailFieldProps {
	label: string;
	children: ReactNode;
	// Label of the most recently copied field; when it equals `copyName` the
	// copy button shows its ✓ confirmation state.
	copied: string | null;
	copyName?: string;
	onCopy: () => void;
	// An extra control rendered before the copy button (e.g. a show/hide toggle).
	extraAction?: ReactNode;
}

/** One labelled, copyable read-only field row shared by every mode's detail view. */
export function DetailField({
	label,
	children,
	copied,
	copyName,
	onCopy,
	extraAction,
}: DetailFieldProps) {
	const { t } = useLingui();
	const matched = copyName ? copied === copyName : false;
	return (
		<div className="space-y-1.5">
			<p className="text-xs text-muted-foreground">{label}</p>
			<div className="flex items-center gap-2 px-3 py-2.5 rounded-md border border-border/50">
				<div className="flex-1 min-w-0">{children}</div>
				{extraAction}
				<button
					type="button"
					onClick={onCopy}
					className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
					aria-label={t`Copy ${label.toLowerCase()}`}
				>
					{matched ? (
						<Check className="w-3.5 h-3.5 text-primary" />
					) : (
						<Copy className="w-3.5 h-3.5" />
					)}
				</button>
			</div>
		</div>
	);
}
