import { useEffect } from "react";
import { cn } from "./utils";

interface ModalProps {
	open: boolean;
	onClose: () => void;
	// dialogs (e.g. a one-time recovery code the user has to save first).
	dismissable?: boolean;
	className?: string;
	children: React.ReactNode;
}

export function Modal({ open, onClose, dismissable = true, className, children }: ModalProps) {
	useEffect(() => {
		if (!open || !dismissable) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, dismissable, onClose]);

	if (!open) return null;
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
			<button
				type="button"
				aria-label="Close"
				tabIndex={-1}
				onClick={dismissable ? onClose : undefined}
				className="absolute inset-0 bg-black/50 backdrop-blur-sm"
			/>
			<div
				role="dialog"
				aria-modal="true"
				className={cn(
					"relative w-full max-w-md rounded-xl border border-border bg-card shadow-xl",
					// the body instead of clipping the title/actions off-screen.
					"max-h-[calc(100vh-2rem)] overflow-y-auto",
					className,
				)}
			>
				{children}
			</div>
		</div>
	);
}
