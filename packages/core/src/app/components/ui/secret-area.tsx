import { Eye, EyeOff } from "lucide-react";
import { type ComponentProps, forwardRef, useId, useState } from "react";
import { cn } from "./utils";

interface SecretAreaProps extends Omit<ComponentProps<"textarea">, "id" | "placeholder"> {
	label: string;
	error?: string;
	// Start revealed instead of masked (e.g. when there's nothing secret to hide yet).
	defaultRevealed?: boolean;
}

/**
 * Multi-line secret field for SSH keys etc. Masking uses CSS `-webkit-text-security`
 * (Chromium-only) so the textarea stays editable while hidden.
 */
export const SecretArea = forwardRef<HTMLTextAreaElement, SecretAreaProps>(function SecretArea(
	{ label, error, className, disabled, rows = 6, defaultRevealed = false, ...props },
	ref,
) {
	const id = useId();
	const invalid = Boolean(error);
	const [revealed, setRevealed] = useState(defaultRevealed);
	return (
		<div>
			<div className="group relative">
				<textarea
					ref={ref}
					id={id}
					rows={rows}
					disabled={disabled}
					placeholder=" "
					spellCheck={false}
					autoCapitalize="off"
					autoCorrect="off"
					aria-invalid={invalid || undefined}
					className={cn(
						"peer relative block w-full appearance-none bg-transparent",
						"px-3 pt-3 pb-3 pr-10 text-sm text-foreground font-mono resize-none",
						"placeholder-transparent outline-none",
						"disabled:opacity-50 disabled:cursor-not-allowed",
						// Mask characters while hidden, editable unlike type=password.
						!revealed && "[-webkit-text-security:disc]",
						className,
					)}
					{...props}
				/>
				<button
					type="button"
					onClick={() => setRevealed((v) => !v)}
					className="absolute right-2 top-2 z-10 p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
					aria-label={revealed ? "Hide value" : "Show value"}
				>
					{revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
				</button>
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
