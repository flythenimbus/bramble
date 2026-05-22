import { ChevronDown } from "lucide-react";
import { type ComponentProps, forwardRef, type ReactNode, useId } from "react";
import { cn } from "./utils";

interface SelectFieldProps extends Omit<ComponentProps<"select">, "id"> {
	label: string;
	error?: string;
	children: ReactNode;
}

// open.
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
				<fieldset
					aria-hidden
					className={cn(
						"pointer-events-none absolute inset-0 rounded-md border border-border/50 px-2 m-0 transition-colors",
						"peer-focus:border-primary",
						invalid && "border-destructive peer-focus:border-destructive",
					)}
				>
					<legend className="block invisible h-0 max-w-full overflow-hidden whitespace-nowrap text-[0.66rem]">
						<span className="px-1">{label}</span>
					</legend>
				</fieldset>
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
