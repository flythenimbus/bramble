import glyph from "../../assets/bramble-glyph.png";

interface BrambleGlyphProps {
	className?: string;
}

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
