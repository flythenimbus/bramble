import { Trans, useLingui } from "@lingui/react/macro";
import { Download } from "lucide-react";
import { usePlatform } from "../../../../context/PlatformContext";
import { useVault } from "../../../../hooks/useVault";
import { Row, Section } from "./primitives";

const rowBtn =
	"px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all";

/** Import / local export. Shown under the Data tab alongside cloud backups. */
export function DataSection() {
	const { shell } = usePlatform();
	const { exportVault } = useVault();
	const { t } = useLingui();
	return (
		<Section icon={<Download className="w-4 h-4 text-primary" />} title={t`Data`}>
			<Row
				icon={<Download className="w-4 h-4 text-primary" />}
				title={t`Import from another manager`}
				subtitle={t`Bring entries in from 1Password, Bitwarden, KeePass or Proton Pass`}
			>
				<button type="button" onClick={() => void shell.openSetup("import")} className={rowBtn}>
					<Trans>Import</Trans>
				</button>
			</Row>
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
		</Section>
	);
}
