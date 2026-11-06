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
			{combined.leftBehind.alias && (
				<p className="text-xs text-muted-foreground">
					<Trans>
						The desktop's vault has its own email alias provider, so this vault's wasn't brought
						over.
					</Trans>
				</p>
			)}
			{combined.leftBehind.backupTargets && (
				<p className="text-xs text-muted-foreground">
					<Trans>
						The desktop's vault already has a backup target, so this vault's weren't brought over.
					</Trans>
				</p>
			)}
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
							disabled={link.finishingCombine}
							onClick={() => void link.copyHeldBack()}
						>
							<Trans>Copy them anyway</Trans>
						</Button>
						{asking && (
							<Button
								variant="ghost"
								size="sm"
								disabled={link.finishingCombine}
								onClick={() => void link.removeOldVault()}
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
			{asking && held === 0 && (
				<Button
					variant="secondary"
					size="sm"
					disabled={link.finishingCombine}
					onClick={() => void link.removeOldVault()}
				>
					<Trans>Remove the old vault</Trans>
				</Button>
			)}
		</div>
	);
}
