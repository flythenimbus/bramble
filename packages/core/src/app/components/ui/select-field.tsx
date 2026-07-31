import { ChevronDown } from "lucide-react";
import { type ComponentProps, forwardRef, type ReactNode, useId } from "react";
import { FieldOutline } from "./field-outline";
import { cn } from "./utils";

interface SelectFieldProps extends Omit<ComponentProps<"select">, "id"> {
	label: string;
	error?: string;
	children: ReactNode;
}

/**
 * Outlined fieldset/legend field (like TextField) for native <select>. The label
 * always floats since a select always has a value, so the legend notch stays open.
 */
export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
	{ label, error, className, disabled, children, ...props },
	ref,
) {
	const id = useId();
	const invalid = Boolean(error);
	return (
		<div>
			<div className="relative">
				<select
					ref={ref}
					id={id}
					disabled={disabled}
					aria-invalid={invalid || undefined}
					className={cn(
						"peer relative block w-full appearance-none bg-transparent",
						"px-3 pt-3 pb-3 pr-9 text-sm text-foreground cursor-pointer",
						"outline-none",
						"disabled:opacity-50 disabled:cursor-not-allowed",
						className,
					)}
					{...props}
				>
					{children}
				</select>
				<FieldOutline label={label} invalid={invalid} notch="always" />
				<label
					htmlFor={id}
					className={cn(
						"pointer-events-none absolute left-3 top-0 -translate-y-1/2 origin-[0]",
						"text-sm scale-75",
						invalid ? "text-destructive" : "text-muted-foreground peer-focus:text-primary",
					)}
				>
					{label}
				</label>
				<ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
			</div>
			{error && <p className="text-xs text-destructive mt-1">{error}</p>}
		</div>
	);
});
