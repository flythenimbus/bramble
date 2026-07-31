import { type ComponentProps, forwardRef, useId } from "react";
import { FieldOutline } from "./field-outline";
import { cn } from "./utils";

interface TextAreaProps extends Omit<ComponentProps<"textarea">, "id" | "placeholder"> {
	label: string;
	error?: string;
}

/** Multi-line text field (same fieldset+legend pattern as TextField), with a top-pinned label. */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
	{ label, error, className, disabled, rows = 3, ...props },
	ref,
) {
	const id = useId();
	const invalid = Boolean(error);
	return (
		<div>
			<div className="group relative">
				<textarea
					ref={ref}
					id={id}
					rows={rows}
					disabled={disabled}
					placeholder=" "
					aria-invalid={invalid || undefined}
					className={cn(
						"peer relative block w-full appearance-none bg-transparent",
						"px-3 pt-3 pb-3 text-sm text-foreground resize-none",
						"placeholder-transparent outline-none",
						"disabled:opacity-50 disabled:cursor-not-allowed",
						className,
					)}
					{...props}
				/>
				<FieldOutline label={label} invalid={invalid} notch="textarea" />
				<label
					htmlFor={id}
					className={cn(
						"pointer-events-none absolute left-3 top-3 origin-[0]",
						"text-sm text-muted-foreground transition-all duration-150",
						"peer-focus:top-0 peer-focus:-translate-y-1/2 peer-focus:scale-75 peer-focus:text-primary",
						"peer-[:not(:placeholder-shown)]:top-0 peer-[:not(:placeholder-shown)]:-translate-y-1/2 peer-[:not(:placeholder-shown)]:scale-75",
						invalid && "text-destructive peer-focus:text-destructive",
					)}
				>
					{label}
				</label>
			</div>
			{error && <p className="text-xs text-destructive mt-1">{error}</p>}
		</div>
	);
});
