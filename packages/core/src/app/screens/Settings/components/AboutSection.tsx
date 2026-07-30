import { Trans, useLingui } from "@lingui/react/macro";
import { Info } from "lucide-react";
import { useEffect, useState } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import { Section } from "./primitives";

// Public repository. External-origin links open in a new tab on the extension and in the
// system browser on mobile (Capacitor's default for cross-origin links).
const GITHUB_URL = "https://github.com/flythenimbus/bramble";

const linkClass = "text-primary hover:underline";

/** About tab: app version and links to the source. */
export function AboutSection() {
	const { shell, autofill } = usePlatform();
	const { t } = useLingui();
	// TEMPORARY: the credential provider runs in its own process, so a failed passkey lookup
	// leaves no trace in the app. This mirrors its last line here, which beats attaching a Mac
	// and reading Console. Remove once the imported-passkey report is closed.
	const [diagnostic, setDiagnostic] = useState("");
	const read = autofill.readDiagnostic;
	useEffect(() => {
		if (read)
			void read()
				.then(setDiagnostic)
				.catch(() => {});
	}, [read]);
	return (
		<Section icon={<Info className="w-4 h-4 text-primary" />} title={t`About`}>
			<div className="flex items-center justify-between text-sm">
				<span className="text-muted-foreground">
					<Trans>Version</Trans>
				</span>
				<span>{shell.version}</span>
			</div>
			{diagnostic && (
				<div className="text-xs">
					<span className="text-muted-foreground">
						<Trans>AutoFill diagnostic</Trans>
					</span>
					<p className="mt-1 font-mono break-all text-muted-foreground">{diagnostic}</p>
				</div>
			)}
			<div className="flex items-center justify-between text-sm">
				<span className="text-muted-foreground">
					<Trans>Source code</Trans>
				</span>
				<span className="flex items-center gap-2">
					<a href={GITHUB_URL} target="_blank" rel="noreferrer noopener" className={linkClass}>
						GitHub
					</a>
				</span>
			</div>
		</Section>
	);
}
