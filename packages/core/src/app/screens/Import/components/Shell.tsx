import { useLingui } from "@lingui/react/macro";
import { X } from "lucide-react";
import { Button } from "../../../components/ui/button";

/** Page chrome shared by every import state. `onClose` shows a close affordance for
 * single-window hosts (mobile) that return to the app; the extension opens import in
 * its own tab, so it passes nothing. */
export function Shell({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
	const { t } = useLingui();
	return (
		<div className="relative min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center p-6">
			{onClose && (
				<Button
					variant="ghost"
					size="icon"
					onClick={onClose}
					aria-label={t`Close import`}
					className="absolute top-4 right-4 z-10 text-muted-foreground hover:text-foreground"
				>
					<X className="w-4 h-4" />
				</Button>
			)}
			<div className="w-full max-w-xl">{children}</div>
		</div>
	);
}
