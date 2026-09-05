import { cn } from "./utils";

function colorFor(char: string): string {
	if (char >= "0" && char <= "9") return "text-sky-500";
	return /[a-z]/i.test(char) ? "" : "text-amber-500";
}

/**
 * A secret rendered for reading off the screen: monospace, wrapping anywhere, with digits and
 * punctuation colored apart from letters so a value can be typed by hand into a device that
 * can't be autofilled. Spaces render as non-breaking, so a trailing or doubled one is visible.
 */
export function SecretText({ value, className }: { value: string; className?: string }) {
	return (
		<p className={cn("font-mono text-sm break-all leading-relaxed", className)}>
			{[...value].map((char, i) => (
				<span key={i} className={colorFor(char)}>
					{char === " " ? "\u00a0" : char}
				</span>
			))}
		</p>
	);
}
