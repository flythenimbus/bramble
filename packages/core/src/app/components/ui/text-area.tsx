import { type ComponentProps, forwardRef, useId } from "react";
import { cn } from "./utils";

interface TextAreaProps extends Omit<ComponentProps<"textarea">, "id" | "placeholder"> {
	label: string;
	error?: string;
}

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
				<fieldset
					aria-hidden
					className={cn(
						"pointer-events-none absolute inset-0 rounded-md border border-border/50 px-2 m-0 transition-colors",
						"peer-focus:border-primary",
						invalid && "border-destructive peer-focus:border-destructive",
					)}
				>
					<legend
						className={cn(
							"block invisible h-0 max-w-[0.01px] overflow-hidden whitespace-nowrap text-[0.66rem]",
							"transition-[max-width] duration-150",
							"group-focus-within:max-w-full",
							"group-has-[textarea:not(:placeholder-shown)]:max-w-full",
						)}
					>
						<span className="px-1">{label}</span>
					</legend>
				</fieldset>
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
