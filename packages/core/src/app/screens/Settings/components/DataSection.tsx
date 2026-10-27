import { Trans, useLingui } from "@lingui/react/macro";
import {
	ArchiveRestore,
	ArrowLeftRight,
	DatabaseBackup,
	Download,
	KeyRound,
	Upload,
} from "lucide-react";
import { useState } from "react";
import { BackupIncompleteError } from "../../../../backup/archive";
import { usePlatform } from "../../../../context/PlatformContext";
import {
	exchangeBlockedReason,
	useExchangeAvailability,
} from "../../../../hooks/useExchangeAvailability";
import { useVault } from "../../../../hooks/useVault";
import { blockedMessage } from "../../../components/backup-blocked";
import { Button } from "../../../components/ui/button";
import { useToast } from "../../../components/ui/toast";
import { KdbxExportDialog } from "./KdbxExportDialog";
import { Row, RowGroup, Section } from "./primitives";

/**
 * Import & backup, split by whose format it is: our own `.bramble` (round-trips everything,
 * stays encrypted) above, other vendors' formats below. Each group pairs its import with its
 * export so the way in and the way out sit together.
 */
export function DataSection() {
	const { shell, exchange, crypto } = usePlatform();
	const { exportVault, exportToApp, files } = useVault();
	const { t } = useLingui();
	const { show } = useToast();
	const [kdbxOpen, setKdbxOpen] = useState(false);
	const [sending, setSending] = useState(false);
	// Presence of the adapter only means this build can ask. Whether THIS device can transfer
	// is a runtime answer, and when it's no the row says why rather than vanishing.
	const availability = useExchangeAvailability();
	const blocked = exchangeBlockedReason(availability);

	// The OS runs the picker and the consent sheet, so the only outcomes we report are the
	// lossy-mapping warnings and an outright failure. A cancel is silent by design.
	const send = async () => {
		setSending(true);
		try {
			const warnings = await exportToApp();
			if (warnings.length > 0) {
				show({ message: warnings[0] ?? "", variant: "info", icon: ArrowLeftRight });
			}
		} catch {
			show({
				message: t`That transfer didn't go through.`,
				variant: "error",
				icon: ArrowLeftRight,
			});
		} finally {
			setSending(false);
		}
	};
	return (
		<Section icon={<DatabaseBackup className="w-4 h-4 text-primary" />} title={t`Import & backup`}>
			<RowGroup label={shell.appName}>
				<Row
					icon={<ArchiveRestore className="w-4 h-4 text-primary" />}
					title={t`Import a backup`}
					subtitle={t`Restore an encrypted .bramble backup. It's added as a new vault, so nothing here is replaced.`}
				>
					<Button variant="secondary" size="sm" onClick={() => void shell.openSetup("restore")}>
						<Trans>Restore</Trans>
					</Button>
				</Row>
				{shell.exportBytes && (
					<Row
						icon={<Download className="w-4 h-4 text-primary" />}
						title={t`Export a backup`}
						subtitle={t`Save an encrypted .bramble copy of your vault. It still needs your master password to open.`}
					>
						{/* Both groups render a button reading "Export"; the aria-label distinguishes them
						    for screen readers, which would otherwise announce the pair identically. */}
						<Button
							variant="secondary"
							size="sm"
							aria-label={t`Export an encrypted backup`}
							onClick={() =>
								// Refused whole rather than saved without some of the vault: a file that looks
								// like a backup and is not one is worse than no file.
								void exportVault().catch((e) => {
									show({
										message:
											e instanceof BackupIncompleteError
												? blockedMessage(e.blocked)
												: t`Couldn't export the backup: ${(e as Error).message}`,
										variant: "error",
										icon: Download,
									});
								})
							}
						>
							<Trans>Export</Trans>
						</Button>
					</Row>
				)}
			</RowGroup>
			<hr className="border-t border-border/50" />
			<RowGroup label={t`Other vendors`}>
				<Row
					icon={<Upload className="w-4 h-4 text-primary" />}
					title={t`Import from another manager`}
					subtitle={t`Bring entries in from 1Password, Bitwarden, KeePass, Proton Pass, Apple or Google`}
				>
					<Button variant="secondary" size="sm" onClick={() => void shell.openSetup("import")}>
						<Trans>Import</Trans>
					</Button>
				</Row>
				{shell.exportBytes && crypto.saveKdbx && (
					<Row
						icon={<KeyRound className="w-4 h-4 text-primary" />}
						title={t`Export as KeePass`}
						subtitle={t`Save a .kdbx you can open in KeePassXC or any KeePass app, under a password you pick.`}
					>
						<Button
							variant="secondary"
							size="sm"
							aria-label={t`Export as KeePass`}
							onClick={() => setKdbxOpen(true)}
						>
							<Trans>Export</Trans>
						</Button>
					</Row>
				)}
				{exchange && (
					<Row
						icon={<ArrowLeftRight className="w-4 h-4 text-primary" />}
						title={t`Send to another app`}
						subtitle={
							blocked ??
							(files.length > 0
								? t`Hand your logins, codes and passkeys straight to another password app on this device. Attachments aren't sent, so keep a backup for those.`
								: t`Hand your logins, codes and passkeys straight to another password app on this device. Nothing is written to a file.`)
						}
					>
						<Button
							variant="secondary"
							size="sm"
							disabled={sending || blocked !== null || availability === null}
							aria-label={t`Send to another app`}
							onClick={() => void send()}
						>
							{sending ? <Trans>Sending…</Trans> : <Trans>Send</Trans>}
						</Button>
					</Row>
				)}
			</RowGroup>
			<KdbxExportDialog open={kdbxOpen} onClose={() => setKdbxOpen(false)} />
		</Section>
	);
}
