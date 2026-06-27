import { useLingui } from "@lingui/react/macro";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { cn } from "./utils";

interface ModalProps {
	open: boolean;
	onClose: () => void;
	// When false, backdrop clicks and Esc don't dismiss, for must-acknowledge
	// dialogs (e.g. a one-time recovery code the user has to save first).
	dismissable?: boolean;
	className?: string;
	/** Backdrop styling; defaults to a 50% blurred scrim. Override to dim harder. */
	backdropClassName?: string;
	children: React.ReactNode;
}

/** Centered modal with a blurred backdrop. No focus-trap; Esc + backdrop dismiss when `dismissable`. */
export function Modal({
	open,
	onClose,
	dismissable = true,
	className,
	backdropClassName = "bg-black/50 backdrop-blur-sm",
	children,
}: ModalProps) {
	const { t } = useLingui();
	useEffect(() => {
		if (!open || !dismissable) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, dismissable, onClose]);

	// Lock page scroll while open so the dimmed page behind can't move.
	useEffect(() => {
		if (!open) return;
		const previous = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = previous;
		};
	}, [open]);

	if (!open) return null;
	// Portal to <body> so the fixed overlay is viewport-relative (not trapped by an
	// ancestor's containing block / stacking context) and dims the whole page.
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
			<button
				type="button"
				aria-label={t`Close`}
				tabIndex={-1}
				onClick={dismissable ? onClose : undefined}
				className={cn("absolute inset-0", backdropClassName)}
			/>
			<div
				role="dialog"
				aria-modal="true"
				className={cn(
					"relative w-full max-w-md rounded-xl border border-border bg-card shadow-xl",
					// Never taller than the viewport (popup windows are short), scroll
					// the body instead of clipping the title/actions off-screen.
					"max-h-[calc(100vh-2rem)] overflow-y-auto",
					className,
				)}
			>
				{children}
			</div>
		</div>,
		document.body,
	);
}
