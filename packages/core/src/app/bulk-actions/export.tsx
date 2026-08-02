import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { FileDown } from "lucide-react";
import { usePlatform } from "../../context/PlatformContext";
import { sealPortableVaultFile } from "../../export/portable-vault";
import { FilePasswordDialog } from "../components/ui/file-password-dialog";
import type { BulkAction, BulkActionDialogProps } from "./types";

function ExportDialog({ open, onClose, onDone, entries, hiddenCount }: BulkActionDialogProps) {
	const { crypto, shell } = usePlatform();

	const run = async (password: string) => {
		const bytes = await sealPortableVaultFile(crypto, entries, password);
		const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
		if (!shell.exportBytes) throw new Error("Saving a file isn't available here.");
		await shell.exportBytes(
			`bramble-selection-${stamp}.bramble`,
			bytes,
			"application/octet-stream",
		);
		onDone();
	};

	return (
		<FilePasswordDialog
			open={open}
			onClose={onClose}
			title={<Trans>Export selection (.bramble)</Trans>}
			description={
				<Trans>
					Pick a password for the exported file. It's separate from your master password, and it's
					the only way to open the file, so we don't keep a copy.
				</Trans>
			}
			detail={
				<>
					<Plural
						value={entries.length}
						one="# entry goes into the file, with its passkeys and history."
						other="# entries go into the file, with their passkeys and history."
					/>
					{hiddenCount > 0 && (
						<>
							{" "}
							<Plural
								value={hiddenCount}
								one="# of them is hidden by the current filter."
								other="# of them are hidden by the current filter."
							/>
						</>
					)}
				</>
			}
			submitLabel={<Trans>Export</Trans>}
			busyLabel={<Trans>Exporting…</Trans>}
			onSubmit={run}
		/>
	);
}

export const exportAction: BulkAction = {
	id: "export",
	get label() {
		return i18n._(msg`Export selection`);
	},
	icon: FileDown,
	// Needs somewhere to write the file and a core that can seal one. Both are optional
	// adapter members, so where either is missing the action is hidden rather than shown
	// broken: mobile has no shell.exportBytes, and a binding layer without the portable
	// vault calls has no sealPortableVault.
	isAvailable: (platform) =>
		Boolean(platform.shell.exportBytes && platform.crypto.sealPortableVault),
	Dialog: ExportDialog,
};
