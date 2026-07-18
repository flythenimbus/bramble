import { Trans, useLingui } from "@lingui/react/macro";
import { ArchiveRestore, DatabaseBackup, Download, Upload } from "lucide-react";
import { usePlatform } from "../../../../context/PlatformContext";
import { useVault } from "../../../../hooks/useVault";
import { Button } from "../../../components/ui/button";
import { Row, Section } from "./primitives";

/** Import & backup: restore a .bramble, export a .bramble, or import from another manager. */
export function DataSection() {
	const { shell } = usePlatform();
	const { exportVault } = useVault();
	const { t } = useLingui();
	return (
		<Section icon={<DatabaseBackup className="w-4 h-4 text-primary" />} title={t`Import & backup`}>
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
					<Button variant="secondary" size="sm" onClick={() => void exportVault().catch(() => {})}>
						<Trans>Export</Trans>
					</Button>
				</Row>
			)}
			<Row
				icon={<Upload className="w-4 h-4 text-primary" />}
				title={t`Import from another manager`}
				subtitle={t`Bring entries in from 1Password, Bitwarden, KeePass or Proton Pass`}
			>
				<Button variant="secondary" size="sm" onClick={() => void shell.openSetup("import")}>
					<Trans>Import</Trans>
				</Button>
			</Row>
		</Section>
	);
}
