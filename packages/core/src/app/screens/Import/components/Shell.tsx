import { X } from "lucide-react";

/** Page chrome shared by every import state. `onClose` shows a close affordance for
 * single-window hosts (mobile) that return to the app; the extension opens import in
 * its own tab, so it passes nothing. */
export function Shell({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
	return (
		<div className="relative min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center p-6">
			{onClose && (
				<button
					type="button"
					onClick={onClose}
					aria-label="Close import"
					className="absolute top-4 right-4 z-10 p-2 rounded-lg border border-transparent text-muted-foreground hover:bg-primary/10 hover:border-border hover:text-foreground active:scale-[0.95] transition-all"
				>
					<X className="w-4 h-4" />
				</button>
			)}
			<div className="w-full max-w-xl">{children}</div>
		</div>
	);
}
