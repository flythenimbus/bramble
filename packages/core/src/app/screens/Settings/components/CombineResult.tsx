import { Trans } from "@lingui/react/macro";
import { Button } from "../../../components/ui/button";
import type { useDesktopLink } from "../../../hooks/useDesktopLink";

/** What a combine left behind, said plainly: look-alikes held back, and files it could not carry. */
export function CombineResult({ link }: { link: ReturnType<typeof useDesktopLink> }) {
	const combined = link.combined;
	if (!combined) return null;
	const held = combined.heldBack.items.length;
	const uncarried = combined.uncarried;
	return (
		<div className="space-y-2">
			{held > 0 && (
				<div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
					<span>
						<Trans>
							{held} entries looked like ones the desktop's vault already has, so they stayed in the
							old vault.
						</Trans>
					</span>
					<Button variant="secondary" size="sm" onClick={() => void link.copyHeldBack()}>
						<Trans>Copy them anyway</Trans>
					</Button>
				</div>
			)}
			{combined.quarantined > 0 && (
				<p className="text-xs text-muted-foreground">
					<Trans>{combined.quarantined} damaged entries stayed in the old vault.</Trans>
				</p>
			)}
			{uncarried > 0 && (
				<p className="text-xs text-destructive">
					<Trans>
						{uncarried} files didn't copy. They are still in the old vault, which is kept until you
						delete it.
					</Trans>
				</p>
			)}
			{combined.keptUnasked && (
				<p className="text-xs text-muted-foreground">
					<Trans>Some of it didn't copy, so the old vault is kept.</Trans>
				</p>
			)}
		</div>
	);
}
