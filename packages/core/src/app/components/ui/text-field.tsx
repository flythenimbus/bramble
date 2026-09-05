import { type ComponentProps, forwardRef, type ReactNode, useId } from "react";
import { FieldOutline, type FieldSize } from "./field-outline";
import { cn } from "./utils";

// `size` shadows the input's own character-width attribute, which nothing here uses.
interface TextFieldProps extends Omit<ComponentProps<"input">, "id" | "placeholder" | "size"> {
	label: string;
	error?: string;
	startAdornment?: ReactNode;
	endAdornment?: ReactNode;
	/** `sm` for dense panels (the generator's symbol set). Default `md`. */
	size?: FieldSize;
}

interface SizeClasses {
	/** Padding and text size on the input itself. */
	input: string;
	/** Room made for each adornment, and where the leading one sits. */
	startPad: string;
	startPos: string;
	endPad: string;
	/** Resting label: text size and left offset. */
	label: string;
	/** Left offset while the label rests beside a leading adornment. */
	labelStart: string;
	/** Where the label goes once it floats, on focus or on having a value. */
	float: string;
}

/**
 * Geometry per size, spelled out rather than composed: Tailwind only scans whole class names,
 * so an interpolated `peer-focus:left-${n}` would never be generated.
 */
const SIZES: Record<FieldSize, SizeClasses> = {
	md: {
		input: "px-3 pt-3 pb-3 text-sm",
		startPad: "pl-10",
		startPos: "left-3",
		endPad: "pr-10",
		label: "text-sm left-3",
		labelStart: "left-10",
		float:
			"peer-focus:top-0 peer-focus:scale-75 peer-focus:left-3 peer-[:not(:placeholder-shown)]:top-0 peer-[:not(:placeholder-shown)]:scale-75 peer-[:not(:placeholder-shown)]:left-3",
	},
	sm: {
		input: "px-2.5 pt-2 pb-2 text-xs",
		startPad: "pl-8",
		startPos: "left-2.5",
		endPad: "pr-8",
		label: "text-xs left-2.5",
		labelStart: "left-8",
		float:
			"peer-focus:top-0 peer-focus:scale-75 peer-focus:left-2.5 peer-[:not(:placeholder-shown)]:top-0 peer-[:not(:placeholder-shown)]:scale-75 peer-[:not(:placeholder-shown)]:left-2.5",
	},
};

/**
 * MUI-style outlined text field. The fieldset/legend draws the border so the
 * label gap is a real notch in the border-top, with no bg-color matching.
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
	{ label, error, className, type, disabled, startAdornment, endAdornment, size = "md", ...props },
	ref,
) {
	const id = useId();
	const invalid = Boolean(error);
	const sized = SIZES[size];
	return (
		<div>
			<div className="group relative">
				{startAdornment && (
					<div
						className={cn(
							"pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground flex items-center z-10",
							sized.startPos,
						)}
					>
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
						"peer relative block w-full appearance-none bg-transparent text-foreground",
						sized.input,
						"placeholder-transparent outline-none",
						"disabled:opacity-50 disabled:cursor-not-allowed",
						startAdornment && sized.startPad,
						endAdornment && sized.endPad,
						className,
					)}
					{...props}
				/>
				<FieldOutline label={label} invalid={invalid} notch="input" size={size} />
				<label
					htmlFor={id}
					className={cn(
						"pointer-events-none absolute top-1/2 -translate-y-1/2 origin-[0]",
						"text-muted-foreground transition-all duration-150",
						sized.label,
						startAdornment && sized.labelStart,
						// Floats on focus and on having a value, back to the field's own left edge
						// regardless of a start adornment.
						sized.float,
						"peer-focus:text-primary",
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
