import type { ReactNode } from "react";
import { cn } from "./utils";

/**
 * How the legend opens the notch the floating label sits in.
 *
 * - `input`: keyed to the INPUT's focus, not the group's `:focus-within`. An adornment button
 *   (the password reveal) also lives in the group, so `focus-within` notched the border while
 *   the label, which keys off the input, stayed centred: a gap in the border with nothing in
 *   it. Do not "simplify" this back.
 * - `textarea`: `focus-within` is safe here, there is no adornment inside the group.
 * - `always`: a select always has a value, so the notch never closes and needs no transition.
 */
export type FieldNotch = "input" | "textarea" | "always";

const NOTCH: Record<FieldNotch, string[]> = {
	input: [
		"group-has-[input:focus]:max-w-full",
		"group-has-[input:not(:placeholder-shown)]:max-w-full",
	],
	textarea: [
		"group-focus-within:max-w-full",
		"group-has-[textarea:not(:placeholder-shown)]:max-w-full",
	],
	always: [],
};

/**
 * The notched outline behind a floating-label field: the border, plus a legend that opens to
 * make room for the label. Shared by every field control so the border treatment can't drift
 * between them (it had, in four copies).
 */
export function FieldOutline({
	label,
	invalid,
	notch,
}: {
	label: ReactNode;
	invalid?: boolean;
	notch: FieldNotch;
}) {
	return (
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
					"block invisible h-0 overflow-hidden whitespace-nowrap text-[0.66rem]",
					notch === "always"
						? "max-w-full"
						: ["max-w-[0.01px]", "transition-[max-width] duration-150", ...NOTCH[notch]],
				)}
			>
				<span className="px-1">{label}</span>
			</legend>
		</fieldset>
	);
}
