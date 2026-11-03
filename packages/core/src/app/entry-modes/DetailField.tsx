import { useLingui } from "@lingui/react/macro";
import { Check, Copy } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/utils";

interface DetailValueProps {
	children: ReactNode;
	mono?: boolean;
	// Revealed secrets wrap instead of truncating: they are revealed to be read.
	wrap?: boolean;
}

/** Value text for a detail row. Block-level because `truncate` on an inline span spills past the border. */
export function DetailValue({ children, mono, wrap }: DetailValueProps) {
	return (
		<span
			className={cn(
				"block text-sm",
				mono && "font-mono",
				wrap ? "break-all max-h-40 overflow-y-auto" : "truncate",
			)}
		>
			{children}
		</span>
	);
}

interface DetailFieldProps {
	// Shown above a standalone field; inside a Group it only names the copy button.
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

/** One copyable read-only row. Unbordered: its DetailField.Group draws the frame. */
function DetailFieldItem({
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
		<div className="flex items-center gap-2 px-3 py-2.5">
			<div className="flex-1 min-w-0">{children}</div>
			{extraAction}
			<Button
				variant="ghost"
				size="none"
				onClick={onCopy}
				className="p-1.5 rounded-md"
				aria-label={t`Copy ${label.toLowerCase()}`}
			>
				{matched ? (
					<Check className="w-3.5 h-3.5 text-primary" />
				) : (
					<Copy className="w-3.5 h-3.5" />
				)}
			</Button>
		</div>
	);
}

/** One label over DetailField.Items, stacked flush in a single bordered block. */
function DetailFieldGroup({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="space-y-1.5">
			<p className="text-xs text-muted-foreground">{label}</p>
			<div className="rounded-md border border-border/50 divide-y divide-border/50">{children}</div>
		</div>
	);
}

/** One labelled, copyable read-only field shared by every mode's detail view: a Group of one Item. */
export const DetailField = Object.assign(
	function DetailField(props: DetailFieldProps) {
		return (
			<DetailFieldGroup label={props.label}>
				<DetailFieldItem {...props} />
			</DetailFieldGroup>
		);
	},
	{ Group: DetailFieldGroup, Item: DetailFieldItem },
);

interface DetailNotesProps {
	label: string;
	value: string;
	copied: string | null;
	copy: (label: string, value: string) => void;
}

/** Multi-line notes for a detail view; `data-selectable` opts the text back in where desktop.css disables selection. */
export function DetailNotes({ label, value, copied, copy }: DetailNotesProps) {
	const { t } = useLingui();
	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between">
				<p className="text-xs text-muted-foreground">{label}</p>
				<Button
					variant="ghost"
					size="none"
					onClick={() => copy("notes", value)}
					className="p-1.5 rounded-md"
					aria-label={t`Copy ${label.toLowerCase()}`}
				>
					{copied === "notes" ? (
						<Check className="w-3.5 h-3.5 text-primary" />
					) : (
						<Copy className="w-3.5 h-3.5" />
					)}
				</Button>
			</div>
			<p className="text-sm whitespace-pre-wrap" data-selectable>
				{value || "-"}
			</p>
		</div>
	);
}
