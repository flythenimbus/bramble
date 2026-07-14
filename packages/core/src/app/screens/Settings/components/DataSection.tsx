import { Trans, useLingui } from "@lingui/react/macro";
import { ArchiveRestore, DatabaseBackup, Download, Upload } from "lucide-react";
import { useCan, usePlatform } from "../../../../context/PlatformContext";
import { useVault } from "../../../../hooks/useVault";
import { Row, Section } from "./primitives";

const rowBtn =
	"px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all";

/** Import & backup: restore a .bramble, export a .bramble, or import from another manager. */
export function DataSection() {
	const { shell } = usePlatform();
	const canRestore = useCan("restore");
	const { exportVault } = useVault();
	const { t } = useLingui();
	return (
		<Section icon={<DatabaseBackup className="w-4 h-4 text-primary" />} title={t`Import & backup`}>
			{canRestore && (
				<Row
					icon={<ArchiveRestore className="w-4 h-4 text-primary" />}
					title={t`Import a backup`}
					subtitle={t`Restore an encrypted .bramble backup. This replaces the vault on this device.`}
				>
					<button type="button" onClick={() => void shell.openSetup("restore")} className={rowBtn}>
						<Trans>Restore</Trans>
					</button>
				</Row>
			)}
			{shell.exportBytes && (
				<Row
					icon={<Download className="w-4 h-4 text-primary" />}
					title={t`Export a backup`}
					subtitle={t`Save an encrypted .bramble copy of your vault. It still needs your master password to open.`}
				>
					<button
						type="button"
						onClick={() => void exportVault().catch(() => {})}
						className={rowBtn}
					>
						<Trans>Export</Trans>
					</button>
				</Row>
			)}
			<Row
				icon={<Upload className="w-4 h-4 text-primary" />}
				title={t`Import from another manager`}
				subtitle={t`Bring entries in from 1Password, Bitwarden, KeePass or Proton Pass`}
			>
				<button type="button" onClick={() => void shell.openSetup("import")} className={rowBtn}>
					<Trans>Import</Trans>
				</button>
			</Row>
		</Section>
	);
}
