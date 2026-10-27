import { Plural, Trans } from "@lingui/react/macro";
import { useVault } from "../../../../hooks/useVault";
import { FilePasswordDialog } from "../../../components/ui/file-password-dialog";

/**
 * Collects the password for a whole-vault KeePass export. The file is meant to be opened by
 * another manager, so it is deliberately NOT protected by the master password. It carries every
 * attachment, as KeePass attachments. Lossy in one way, and the dialog says so: our KDBX writer
 * drops passkeys. KDBX itself can carry one (KeePassXC stores them as KPEX_PASSKEY_* attributes,
 * which we now IMPORT), so this is a gap in the exporter rather than the format. The .bramble
 * export in the vault list's bulk actions is the lossless route.
 */
export function KdbxExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	const { exportKdbx, conflicts } = useVault();
	// Only the shown version goes into the file, so say when there are others it leaves out.
	const conflicted = [...conflicts.values()].filter((c) => c.versions > 0).length;

	return (
		<FilePasswordDialog
			open={open}
			onClose={onClose}
			title={<Trans>Export as KeePass (.kdbx)</Trans>}
			description={
				<Trans>
					Pick a password for the exported file. It's separate from your master password, and it's
					the only way to open the file: we don't keep a copy. Your attachments go with it. Passkeys
					don't yet, so keep a .bramble backup for those.
				</Trans>
			}
			detail={
				conflicted > 0 ? (
					<Plural
						value={conflicted}
						one="# entry has a sync conflict. Only the version you see is exported."
						other="# entries have a sync conflict. Only the version you see is exported."
					/>
				) : undefined
			}
			submitLabel={<Trans>Export</Trans>}
			busyLabel={<Trans>Exporting…</Trans>}
			onSubmit={exportKdbx}
		/>
	);
}
