import { type ComponentProps, forwardRef, type ReactNode, useId } from "react";
import { FieldOutline } from "./field-outline";
import { cn } from "./utils";

interface TextFieldProps extends Omit<ComponentProps<"input">, "id" | "placeholder"> {
	label: string;
	error?: string;
	startAdornment?: ReactNode;
	endAdornment?: ReactNode;
}

/**
 * MUI-style outlined text field. The fieldset/legend draws the border so the
 * label gap is a real notch in the border-top, with no bg-color matching.
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
	{ label, error, className, type, disabled, startAdornment, endAdornment, ...props },
	ref,
) {
	const id = useId();
	const invalid = Boolean(error);
	return (
		<div>
			<div className="group relative">
				{startAdornment && (
					<div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground flex items-center z-10">
						{startAdornment}
					</div>
				)}
				<input
					ref={ref}
					id={id}
					type={type}
					disabled={disabled}
					placeholder=" "
					aria-invalid={invalid || undefined}
					className={cn(
						"peer relative block w-full appearance-none bg-transparent",
						"px-3 pt-3 pb-3 text-sm text-foreground",
						"placeholder-transparent outline-none",
						"disabled:opacity-50 disabled:cursor-not-allowed",
						startAdornment && "pl-10",
						endAdornment && "pr-10",
						className,
					)}
					{...props}
				/>
				<FieldOutline label={label} invalid={invalid} notch="input" />
				<label
					htmlFor={id}
					className={cn(
						"pointer-events-none absolute top-1/2 -translate-y-1/2 origin-[0]",
						"text-sm text-muted-foreground transition-all duration-150",
						startAdornment ? "left-10" : "left-3",
						// Float when focused, always to left-3 regardless of start adornment
						"peer-focus:top-0 peer-focus:scale-75 peer-focus:left-3 peer-focus:text-primary",
						// Float when input has any value
						"peer-[:not(:placeholder-shown)]:top-0 peer-[:not(:placeholder-shown)]:scale-75 peer-[:not(:placeholder-shown)]:left-3",
						invalid && "text-destructive peer-focus:text-destructive",
					)}
				>
					{label}
				</label>
				{endAdornment && (
					<div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 z-10">
						{endAdornment}
					</div>
				)}
			</div>
			{error && <p className="text-xs text-destructive mt-1">{error}</p>}
		</div>
	);
});
