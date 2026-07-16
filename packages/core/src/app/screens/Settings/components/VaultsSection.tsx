import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowRightLeft, Check, Pencil, Plus, Trash2, Vault, X } from "lucide-react";
import { useState } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import { useVault } from "../../../../hooks/useVault";
import { useVaultRegistry } from "../../../../hooks/useVaultRegistry";
import { displayLabel } from "../../../../vault/vault-registry";
import { Section } from "./primitives";

const iconBtn =
	"p-2 rounded-lg text-muted-foreground hover:bg-primary/10 hover:text-foreground disabled:opacity-40 transition-all";
const actionBtn =
	"px-3 py-2 text-sm rounded-lg border border-border hover:bg-primary/5 flex items-center gap-2";

/** Manage the current vault only: rename it, delete it, or move to another. A vault never acts on other vaults. */
export function VaultsSection() {
	const { vaults, activeId, rename, remove, clearSelection } = useVaultRegistry();
	const { lock } = useVault();
	const { shell } = usePlatform();
	const { t } = useLingui();
	const [renaming, setRenaming] = useState(false);
	const [draft, setDraft] = useState("");
	const [confirming, setConfirming] = useState(false);

	const index = vaults.findIndex((v) => v.id === activeId);
	const current = index >= 0 ? vaults[index] : undefined;
	// Settings is only reachable while a vault is unlocked, so this is defensive.
	if (!current || !activeId) return null;
	const label = displayLabel(current.label, index);

	// Leave the current vault locked, then return to the picker.
	const switchVault = async () => {
		await lock();
		clearSelection();
	};
	// Delete this vault: lock it, then drop its blob + record. The guards route on to the
	// picker (or setup, if it was the last vault).
	const deleteThisVault = async () => {
		await lock();
		await remove(activeId);
	};

	return (
		<Section icon={<Vault className="w-4 h-4 text-primary" />} title={t`Vault`}>
			{renaming ? (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void rename(activeId, draft.trim()).then(() => setRenaming(false));
					}}
					className="flex items-center gap-2"
				>
					<input
						autoFocus
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						placeholder={t`Vault name`}
						aria-label={t`Vault name`}
						className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-border bg-transparent focus:outline-none focus:border-primary/50"
					/>
					<button type="submit" className={iconBtn} aria-label={t`Save`}>
						<Check className="w-4 h-4" />
					</button>
					<button
						type="button"
						onClick={() => setRenaming(false)}
						className={iconBtn}
						aria-label={t`Cancel`}
					>
						<X className="w-4 h-4" />
					</button>
				</form>
			) : (
				<div className="flex items-center gap-3">
					<span className="flex-none w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
						<Vault className="w-4 h-4" />
					</span>
					<div className="flex-1 min-w-0">
						<p className="text-sm truncate">{label}</p>
						<p className="text-xs text-muted-foreground">
							<Trans>This vault</Trans>
						</p>
					</div>
					<button
						type="button"
						onClick={() => {
							setDraft(current.label);
							setRenaming(true);
						}}
						className={iconBtn}
						aria-label={t`Rename`}
						title={t`Rename`}
					>
						<Pencil className="w-4 h-4" />
					</button>
				</div>
			)}

			<div className="flex flex-wrap gap-2">
				<button type="button" onClick={() => void shell.openSetup()} className={actionBtn}>
					<Plus className="w-4 h-4" />
					<Trans>Create new vault</Trans>
				</button>
				{vaults.length > 1 && (
					<button type="button" onClick={() => void switchVault()} className={actionBtn}>
						<ArrowRightLeft className="w-4 h-4" />
						<Trans>Switch vault</Trans>
					</button>
				)}
			</div>

			{confirming ? (
				<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-2">
					<p className="text-xs text-muted-foreground">
						<Trans>
							Delete this vault from this device? Synced copies on your other devices aren't
							affected, and this can't be undone here.
						</Trans>
					</p>
					<div className="flex gap-2">
						<button
							type="button"
							onClick={() => void deleteThisVault()}
							className="px-3 py-1.5 text-xs rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							<Trans>Delete this vault</Trans>
						</button>
						<button
							type="button"
							onClick={() => setConfirming(false)}
							className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5"
						>
							<Trans>Cancel</Trans>
						</button>
					</div>
				</div>
			) : (
				<button
					type="button"
					onClick={() => setConfirming(true)}
					className="flex items-center gap-2 text-xs text-destructive hover:text-destructive/80 transition-colors"
				>
					<Trash2 className="w-4 h-4" />
					<Trans>Delete this vault</Trans>
				</button>
			)}
		</Section>
	);
}
