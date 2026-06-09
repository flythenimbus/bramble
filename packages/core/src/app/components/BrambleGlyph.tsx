import glyph from "../../assets/bramble-glyph.png";

interface BrambleGlyphProps {
	className?: string;
}

/**
 * The Bramble glyph, rendered as a currentColor mask so it tints with `text-*` like any icon.
 * Size and colour come from className (e.g. "w-8 h-8 text-primary-foreground").
 */
export function BrambleGlyph({ className }: BrambleGlyphProps) {
	return (
		<span
			aria-hidden="true"
			className={className}
			style={{
				display: "inline-block",
				backgroundColor: "currentColor",
				WebkitMaskImage: `url(${glyph})`,
				maskImage: `url(${glyph})`,
				WebkitMaskRepeat: "no-repeat",
				maskRepeat: "no-repeat",
				WebkitMaskPosition: "center",
				maskPosition: "center",
				WebkitMaskSize: "contain",
				maskSize: "contain",
			}}
		/>
	);
}
