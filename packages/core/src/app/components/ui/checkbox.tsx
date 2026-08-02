import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./utils";

interface CheckboxProps {
	checked: boolean;
	onChange: (next: boolean) => void;
	/** Accessible name. Redundant when `children` supplies visible label text. */
	ariaLabel?: string;
	/** Visible label text, rendered after the box. */
	children?: ReactNode;
	/** Extra classes for the wrapping label (hit area, spacing). */
	className?: string;
}

/** The app's checkbox: a visually-hidden input driving a styled box, so focus and keyboard still work. */
export function Checkbox({ checked, onChange, ariaLabel, children, className }: CheckboxProps) {
	return (
		<label
			className={cn(
				"flex items-center gap-2 cursor-pointer select-none text-[11px] text-foreground",
				className,
			)}
		>
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
				aria-label={ariaLabel}
				className="peer sr-only"
			/>
			<span
				className={cn(
					"flex items-center justify-center w-4 h-4 shrink-0 rounded border transition-colors",
					"peer-focus-visible:ring-2 peer-focus-visible:ring-primary/50",
					checked ? "bg-primary border-primary" : "border-border bg-transparent",
				)}
			>
				{checked && <Check className="w-3 h-3 text-primary-foreground" strokeWidth={3} />}
			</span>
			{children}
		</label>
	);
}
