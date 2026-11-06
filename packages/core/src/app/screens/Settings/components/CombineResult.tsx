import { Trans } from "@lingui/react/macro";
import { Button } from "../../../components/ui/button";
import type { useDesktopLink } from "../../../hooks/useDesktopLink";

/** What a combine left behind, said plainly: look-alikes to answer for, and files it could not carry. */
export function CombineResult({ link }: { link: ReturnType<typeof useDesktopLink> }) {
	const combined = link.combined;
	if (!combined) return null;
	const held = combined.heldBack.items.length;
	const uncarried = combined.uncarried;
	const asking = combined.pendingRemoval !== null;
	return (
		<div className="space-y-2">
			{held > 0 && (
				<div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
					<span>
						{asking ? (
							<Trans>
								{held} entries look like ones the desktop's vault already has. Copy them before the
								old vault goes?
							</Trans>
						) : (
							<Trans>
								{held} entries looked like ones the desktop's vault already has, so they stayed in
								the old vault.
							</Trans>
						)}
					</span>
					<div className="flex gap-2">
						<Button
							variant="secondary"
							size="sm"
							disabled={link.answeringHeldBack}
							onClick={() => void link.copyHeldBack()}
						>
							<Trans>Copy them anyway</Trans>
						</Button>
						{asking && (
							<Button
								variant="ghost"
								size="sm"
								disabled={link.answeringHeldBack}
								onClick={() => void link.leaveOutHeldBack()}
							>
								<Trans>Leave them out</Trans>
							</Button>
						)}
					</div>
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
