import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { Archive, ArchiveRestore } from "lucide-react";
import { useVault } from "../../hooks/useVault";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import type { BulkAction, BulkActionDialogProps } from "./types";

/**
 * Archive and restore are one transition in two directions, so they share a dialog
 * parameterized by which way it runs. Both are registered, and each greys itself out
 * for a selection already on that side.
 */
function dialogFor(archived: boolean) {
	return function ArchiveDialog({ open, onClose, onDone, ids, entries }: BulkActionDialogProps) {
		const { setEntriesArchived } = useVault();
		// Only the entries this actually moves, so the count matches what happens: a mixed
		// selection run through "Archive" leaves the already-archived ones alone.
		const moving = entries.filter((e) => (e.archivedAt !== undefined) !== archived).length;

		return (
			<ConfirmDialog
				open={open}
				onClose={onClose}
				title={
					archived ? (
						<Plural value={moving} one="Archive # entry?" other="Archive # entries?" />
					) : (
						<Plural value={moving} one="Restore # entry?" other="Restore # entries?" />
					)
				}
				confirmLabel={archived ? <Trans>Archive</Trans> : <Trans>Restore</Trans>}
				busyLabel={archived ? <Trans>Archiving…</Trans> : <Trans>Restoring…</Trans>}
				onConfirm={async () => {
					await setEntriesArchived(ids, archived);
					onDone();
				}}
			>
				<p className="text-sm text-muted-foreground">
					{archived ? (
						<Trans>
							They stay in your vault and in exports, but leave the list and are never offered for
							autofill. You can restore them at any time.
						</Trans>
					) : (
						<Trans>They return to the list and become available for autofill again.</Trans>
					)}
				</p>
			</ConfirmDialog>
		);
	};
}

export const archiveAction: BulkAction = {
	id: "archive",
	get label() {
		return i18n._(msg`Archive`);
	},
	icon: Archive,
	// Nothing to archive in a selection that is already entirely archived.
	isEnabled: (entries) => entries.some((e) => e.archivedAt === undefined),
	Dialog: dialogFor(true),
};

export const restoreAction: BulkAction = {
	id: "restore",
	get label() {
		return i18n._(msg`Restore`);
	},
	icon: ArchiveRestore,
	isEnabled: (entries) => entries.some((e) => e.archivedAt !== undefined),
	Dialog: dialogFor(false),
};
