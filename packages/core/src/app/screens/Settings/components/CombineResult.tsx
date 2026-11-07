import { Plural, Trans } from "@lingui/react/macro";
import { Button } from "../../../components/ui/button";
import { Modal } from "../../../components/ui/modal";
import type { useDesktopLink } from "../../../hooks/useDesktopLink";

/** What a combine did and left behind, and the one thing left to decide: whether the old vault
 * goes. Closing it decides nothing: the vault stays hidden, and Settings asks again. */
export function CombineResult({ link }: { link: ReturnType<typeof useDesktopLink> }) {
	const combined = link.combined;
	if (!combined) return null;
	const held = combined.heldBack.items.length;
	const { uncarried, quarantined, conflicted, leftBehind, keptUnasked, copyUnconfirmed } = combined;
	const asking = combined.pendingRemoval !== null;
	const busy = link.finishingCombine;
	const note = "text-xs text-muted-foreground";
	return (
		<Modal
			open
			onClose={() => {
				if (!busy) link.closeCombined();
			}}
			className="max-w-sm"
		>
			<div className="p-5 space-y-3">
				<h2 className="text-base font-medium">
					{asking ? <Trans>Delete the old vault?</Trans> : <Trans>The old vault stays</Trans>}
				</h2>
				{asking && held === 0 && (
					<p className={note}>
						<Trans>Its entries and files are in the desktop's vault now.</Trans>
					</p>
				)}
				{held > 0 && (
					<div className={`flex flex-wrap items-center justify-between gap-3 ${note}`}>
						<span>
							{asking ? (
								<Plural
									value={held}
									one="# entry looks like one the desktop's vault already has, so it wasn't copied. It goes if you delete the old vault."
									other="# entries look like ones the desktop's vault already has, so they weren't copied. They go if you delete the old vault."
								/>
							) : (
								<Plural
									value={held}
									one="# entry looked like one the desktop's vault already has, so it stayed in the old vault."
									other="# entries looked like ones the desktop's vault already has, so they stayed in the old vault."
								/>
							)}
						</span>
						<Button
							variant="secondary"
							size="sm"
							disabled={busy}
							onClick={() => void link.copyHeldBack()}
						>
							<Trans>Copy them anyway</Trans>
						</Button>
					</div>
				)}
				{held > 0 && (
					<p className="max-h-20 overflow-y-auto text-xs text-foreground">
						{combined.heldBack.items.map((item) => item.name).join(", ")}
					</p>
				)}
				{conflicted > 0 && (
					<p className={note}>
						<Plural
							value={conflicted}
							one="# entry has a sync conflict. Only the version shown came across."
							other="# entries have a sync conflict. Only the version shown came across."
						/>
					</p>
				)}
				{leftBehind.alias && (
					<p className={note}>
						<Trans>
							The desktop's vault has its own email alias provider, so this vault's wasn't brought
							over.
						</Trans>
					</p>
				)}
				{leftBehind.backupTargets && (
					<p className={note}>
						<Trans>
							The desktop's vault already has a backup target, so this vault's weren't brought over.
						</Trans>
					</p>
				)}
				{leftBehind.unreadableTargets > 0 && (
					<p className={note}>
						<Plural
							value={leftBehind.unreadableTargets}
							one="# backup target couldn't be opened, so it wasn't brought over."
							other="# backup targets couldn't be opened, so they weren't brought over."
						/>
					</p>
				)}
				{quarantined > 0 && (
					<p className={note}>
						<Plural
							value={quarantined}
							one="# damaged entry stayed in the old vault."
							other="# damaged entries stayed in the old vault."
						/>
					</p>
				)}
				{uncarried > 0 && (
					<p className="text-xs text-destructive">
						<Plural
							value={uncarried}
							one="# file didn't copy. It is still in the old vault, which is kept until you delete it."
							other="# files didn't copy. They are still in the old vault, which is kept until you delete it."
						/>
					</p>
				)}
				{keptUnasked && (
					<p className={note}>
						<Trans>Some of it didn't copy, so the old vault is kept.</Trans>
					</p>
				)}
				{copyUnconfirmed && (
					<p className={note}>
						<Trans>The copy couldn't be confirmed, so the old vault is kept.</Trans>
					</p>
				)}
				{link.error && <p className="text-xs text-destructive">{link.error}</p>}
				<div className="flex justify-end gap-2 pt-1">
					{asking ? (
						<>
							<Button
								variant="secondary"
								size="sm"
								disabled={busy}
								onClick={() => void link.keepOldVault()}
							>
								<Trans>Keep it</Trans>
							</Button>
							<Button
								variant="destructive"
								size="sm"
								disabled={busy}
								onClick={() => void link.removeOldVault()}
							>
								<Trans>Delete old vault</Trans>
							</Button>
						</>
					) : (
						<Button variant="secondary" size="sm" disabled={busy} onClick={link.closeCombined}>
							<Trans>Done</Trans>
						</Button>
					)}
				</div>
			</div>
		</Modal>
	);
}
