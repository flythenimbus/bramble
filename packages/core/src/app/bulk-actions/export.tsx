import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { FileDown } from "lucide-react";
import { usePlatform } from "../../context/PlatformContext";
import { sealPortableVaultFile } from "../../export/portable-vault";
import { useVaultState } from "../../hooks/useVault";
import { FilePasswordDialog } from "../components/ui/file-password-dialog";
import type { BulkAction, BulkActionDialogProps } from "./types";

function ExportDialog({ open, onClose, onDone, ids, entries, hiddenCount }: BulkActionDialogProps) {
	const { crypto, shell } = usePlatform();
	const { files, conflicts } = useVaultState();
	// A selection carries entries only, so say so rather than leave the files out unannounced.
	const selected = new Set(ids);
	const attachments = files.filter(
		(f) => f.entryId !== undefined && selected.has(f.entryId),
	).length;
	// Only the shown version goes into the file, so say when there are others it leaves out.
	const conflicted = entries.filter((e) => (conflicts.get(e.id)?.versions ?? 0) > 0).length;

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
					{attachments > 0 && (
						<>
							{" "}
							<Plural
								value={attachments}
								one="Attachments aren't transferred: # file on these entries won't be in the export."
								other="Attachments aren't transferred: # files on these entries won't be in the export."
							/>
						</>
					)}
					{conflicted > 0 && (
						<>
							{" "}
							<Plural
								value={conflicted}
								one="# of these entries has a sync conflict. Only the version you see is exported."
								other="# of these entries have a sync conflict. Only the version you see is exported."
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
	// Needs somewhere to write the file. Every platform's core can seal one, so the crypto
	// is not part of the gate: buildCryptoAdapter always defines sealPortableVault and
	// throws inside it if the binding layer is stale, which is the honest backstop.
	isAvailable: (platform) => Boolean(platform.shell.exportBytes),
	Dialog: ExportDialog,
};
