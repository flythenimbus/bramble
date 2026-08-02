import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { Trash2 } from "lucide-react";
import { isLogin, useVault } from "../../hooks/useVault";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import type { BulkAction, BulkActionDialogProps } from "./types";

function DeleteDialog({ open, onClose, onDone, ids, entries, hiddenCount }: BulkActionDialogProps) {
	const { deleteEntries } = useVault();
	// Deleting a login takes its passkeys with it, and nothing else in the flow says so.
	// Counted rather than hedged ("any passkeys they hold"), so the warning only appears
	// when it's true.
	const passkeys = entries.reduce((n, e) => n + (isLogin(e) ? (e.passkeys?.length ?? 0) : 0), 0);

	return (
		<ConfirmDialog
			open={open}
			onClose={onClose}
			destructive
			title={<Plural value={ids.length} one="Delete # entry?" other="Delete # entries?" />}
			confirmLabel={<Trans>Delete</Trans>}
			busyLabel={<Trans>Deleting…</Trans>}
			onConfirm={async () => {
				await deleteEntries(ids);
				onDone();
			}}
		>
			<p className="text-sm text-muted-foreground">
				<Trans>This can't be undone, and the deletion syncs to your other devices.</Trans>
			</p>
			{passkeys > 0 && (
				<p className="text-sm text-muted-foreground">
					<Plural
						value={passkeys}
						one="# passkey is stored on these entries and is deleted with them."
						other="# passkeys are stored on these entries and are deleted with them."
					/>
				</p>
			)}
			{hiddenCount > 0 && (
				<p className="text-sm text-destructive">
					<Plural
						value={hiddenCount}
						one="# of them is hidden by the current filter."
						other="# of them are hidden by the current filter."
					/>
				</p>
			)}
		</ConfirmDialog>
	);
}

export const deleteAction: BulkAction = {
	id: "delete",
	get label() {
		return i18n._(msg`Delete`);
	},
	icon: Trash2,
	destructive: true,
	Dialog: DeleteDialog,
};
