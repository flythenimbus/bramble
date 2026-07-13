import { Trans, useLingui } from "@lingui/react/macro";
import { Info } from "lucide-react";
import { usePlatform } from "../../../../context/PlatformContext";
import { Section } from "./primitives";

// Public repositories. External-origin links open in a new tab on the extension and in the
// system browser on mobile (Capacitor's default for cross-origin links).
const GITHUB_URL = "https://github.com/flythenimbus/bramble";
const CODEBERG_URL = "https://codeberg.org/flythenimbus/bramble";

const linkClass = "text-primary hover:underline";

/** About tab: app version and links to the source. */
export function AboutSection() {
	const { shell } = usePlatform();
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
					<Trans>Source code</Trans>
				</span>
				<span className="flex items-center gap-2">
					<a href={GITHUB_URL} target="_blank" rel="noreferrer noopener" className={linkClass}>
						GitHub
					</a>
					<span className="text-muted-foreground" aria-hidden>
						·
					</span>
					<a href={CODEBERG_URL} target="_blank" rel="noreferrer noopener" className={linkClass}>
						Codeberg
					</a>
				</span>
			</div>
		</Section>
	);
}
