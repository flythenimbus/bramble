import { Trans } from "@lingui/react/macro";
import { Monitor } from "lucide-react";
import { Button } from "../../../components/ui/button";

/** Option B: catch desktop users before they type a password for a vault they do not need. */
export function DesktopLinkBanner({ onLink }: { onLink: () => void }) {
	return (
		<div className="flex items-center gap-3 mb-4 p-3 rounded-lg border border-primary/40 bg-primary/5">
			<Monitor className="w-5 h-5 text-primary shrink-0" />
			<div className="flex-1 min-w-0">
				<p className="text-sm">
					<Trans>Using Bramble desktop?</Trans>
				</p>
				<p className="text-xs text-muted-foreground">
					<Trans>Link it instead of making a new vault.</Trans>
				</p>
			</div>
			<Button size="sm" onClick={onLink}>
				<Trans>Link</Trans>
			</Button>
		</div>
	);
}
