import { Trans, useLingui } from "@lingui/react/macro";
import { ArchiveRestore, DatabaseBackup, Download, KeyRound, Upload } from "lucide-react";
import { useState } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import { useVault } from "../../../../hooks/useVault";
import { Button } from "../../../components/ui/button";
import { KdbxExportDialog } from "./KdbxExportDialog";
import { Row, RowGroup, Section } from "./primitives";

/**
 * Import & backup, split by whose format it is: our own `.bramble` (round-trips everything,
 * stays encrypted) above, other vendors' formats below. Each group pairs its import with its
 * export so the way in and the way out sit together.
 */
export function DataSection() {
	const { shell } = usePlatform();
	const { exportVault } = useVault();
	const { t } = useLingui();
	const [kdbxOpen, setKdbxOpen] = useState(false);
	return (
		<Section icon={<DatabaseBackup className="w-4 h-4 text-primary" />} title={t`Import & backup`}>
			<RowGroup label={shell.appName}>
				<Row
					icon={<ArchiveRestore className="w-4 h-4 text-primary" />}
					title={t`Import a backup`}
					subtitle={t`Restore an encrypted .bramble backup. This replaces the vault on this device.`}
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
							onClick={() => void exportVault().catch(() => {})}
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
				{shell.exportBytes && (
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
			</RowGroup>
			<KdbxExportDialog open={kdbxOpen} onClose={() => setKdbxOpen(false)} />
		</Section>
	);
}
