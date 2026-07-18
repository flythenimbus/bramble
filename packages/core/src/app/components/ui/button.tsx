import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef } from "react";
import { cn } from "./utils";

const button = cva(
	"inline-flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none",
	{
		variants: {
			variant: {
				primary:
					"rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring",
				secondary:
					"rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring",
				destructive:
					"rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring",
				destructiveOutline:
					"rounded-lg border border-destructive/50 text-destructive hover:bg-destructive/10 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring",
				ghost:
					"rounded-lg border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] focus-visible:ring-2 focus-visible:ring-ring",
				link: "text-muted-foreground hover:text-foreground",
			},
			size: {
				sm: "px-3 py-1.5 text-xs",
				md: "px-5 py-2 text-sm",
				lg: "px-5 py-3 text-base",
				icon: "p-2",
				none: "",
			},
			fullWidth: { true: "w-full" },
		},
		defaultVariants: { variant: "secondary", size: "md" },
	},
);

export interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof button> {}

/** Shared button. Variant + size cover the common cases; className overrides anything specific. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{ className, variant, size, fullWidth, type = "button", ...props },
	ref,
) {
	return (
		<button
			ref={ref}
			type={type}
			className={cn(button({ variant, size, fullWidth }), className)}
			{...props}
		/>
	);
});
