import { Trans } from "@lingui/react/macro";
import { type ReactNode, useState } from "react";
import { Button } from "./button";
import { Modal } from "./modal";

interface ConfirmDialogProps {
	open: boolean;
	onClose: () => void;
	title: ReactNode;
	/** Body copy: what the action will do, and anything it can't undo. */
	children?: ReactNode;
	confirmLabel: ReactNode;
	/** Shown on the confirm button while `onConfirm` is in flight. */
	busyLabel: ReactNode;
	destructive?: boolean;
	/** Rejections surface in the dialog rather than being swallowed. */
	onConfirm: () => Promise<void>;
}

/** Yes/no dialog for an action that needs acknowledging but no input. */
export function ConfirmDialog({
	open,
	onClose,
	title,
	children,
	confirmLabel,
	busyLabel,
	destructive,
	onConfirm,
}: ConfirmDialogProps) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const confirm = async () => {
		setBusy(true);
		setError(null);
		try {
			await onConfirm();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal open={open} onClose={() => !busy && onClose()}>
			<div className="p-5 space-y-3">
				<h3 className="text-base">{title}</h3>
				{children}
				{error && <p className="text-sm text-destructive">{error}</p>}
				<div className="flex items-center justify-end gap-2 pt-1">
					<Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						variant={destructive ? "destructive" : "primary"}
						size="sm"
						onClick={confirm}
						disabled={busy}
					>
						{busy ? busyLabel : confirmLabel}
					</Button>
				</div>
			</div>
		</Modal>
	);
}
