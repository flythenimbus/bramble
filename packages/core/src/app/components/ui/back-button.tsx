import { useLingui } from "@lingui/react/macro";
import { ArrowLeft } from "lucide-react";

/** The circular back button shared by the app header (AppLayout) and the setup shell, so both
 * stay visually identical. Caller supplies the navigation via onClick. */
export function BackButton({ onClick, className }: { onClick: () => void; className?: string }) {
	const { t } = useLingui();
	return (
		<button
			type="button"
			onClick={onClick}
			className={`flex items-center justify-center w-9 h-9 rounded-full bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground active:scale-[0.95] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring${
				className ? ` ${className}` : ""
			}`}
			aria-label={t`Go back`}
			title={t`Go back`}
		>
			<ArrowLeft className="w-4 h-4" />
		</button>
	);
}
