import { Trans, useLingui } from "@lingui/react/macro";
import { Info } from "lucide-react";
import { usePlatform } from "../../../../context/PlatformContext";
import { useVault } from "../../../../hooks/useVault";
import { Section } from "./primitives";

/** About tab: app version and total entry count. */
export function AboutSection() {
	const { shell } = usePlatform();
	const { entries } = useVault();
	const { t } = useLingui();
	return (
		<Section icon={<Info className="w-4 h-4 text-primary" />} title={t`About`}>
			<div className="flex items-center justify-between text-sm">
				<span className="text-muted-foreground">
					<Trans>Version</Trans>
				</span>
				<span>{shell.version}</span>
			</div>
			<div className="flex items-center justify-between text-sm">
				<span className="text-muted-foreground">
					<Trans>Total entries</Trans>
				</span>
				<span>{entries.length}</span>
			</div>
		</Section>
	);
}
