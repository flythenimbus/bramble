import { useLingui } from "@lingui/react/macro";
import { Eye, EyeOff } from "lucide-react";
import { type ComponentProps, forwardRef, useId, useState } from "react";
import { Button } from "./button";
import { FieldOutline } from "./field-outline";
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
	const { t } = useLingui();
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
				<Button
					variant="ghost"
					size="none"
					onClick={() => setRevealed((v) => !v)}
					className="absolute right-2 top-2 z-10 p-1.5 rounded-md"
					aria-label={revealed ? t`Hide value` : t`Show value`}
				>
					{revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
				</Button>
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
