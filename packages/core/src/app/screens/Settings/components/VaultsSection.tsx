import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowRightLeft, Check, Pencil, Plus, Star, Trash2, Vault, X } from "lucide-react";
import { useState } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import { useVault } from "../../../../hooks/useVault";
import { useVaultRegistry } from "../../../../hooks/useVaultRegistry";
import { displayLabel } from "../../../../vault/vault-registry";
import { Section } from "./primitives";

const iconBtn =
	"p-2 rounded-lg text-muted-foreground hover:bg-primary/10 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent transition-all";

/** Manage the device's vaults: rename, set primary, delete, create, and switch. */
export function VaultsSection() {
	const { vaults, activeId, primaryId, rename, remove, setPrimaryVault, clearSelection } =
		useVaultRegistry();
	const { lock } = useVault();
	const { shell } = usePlatform();
	const { t } = useLingui();
	const [editing, setEditing] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [confirming, setConfirming] = useState<string | null>(null);

	// Leave the current vault locked, then drop the selection so the picker shows.
	const switchVault = async () => {
		await lock();
		clearSelection();
	};

	return (
		<Section icon={<Vault className="w-4 h-4 text-primary" />} title={t`Vaults`}>
			<div className="space-y-1 -mx-1">
				{vaults.map((v, i) => {
					const label = displayLabel(v.label, i);
					const isCurrent = v.id === activeId;
					const isPrimary = v.id === primaryId;

					if (editing === v.id) {
						return (
							<form
								key={v.id}
								onSubmit={(e) => {
									e.preventDefault();
									void rename(v.id, draft.trim()).then(() => setEditing(null));
								}}
								className="flex items-center gap-2 px-1 py-1.5"
							>
								<input
									autoFocus
									value={draft}
									onChange={(e) => setDraft(e.target.value)}
									placeholder={t`Vault name`}
									aria-label={t`Vault name`}
									className="flex-1 min-w-0 px-3 py-1.5 text-sm rounded-lg border border-border bg-transparent focus:outline-none focus:border-primary/50"
								/>
								<button type="submit" className={iconBtn} aria-label={t`Save`}>
									<Check className="w-4 h-4" />
								</button>
								<button
									type="button"
									onClick={() => setEditing(null)}
									className={iconBtn}
									aria-label={t`Cancel`}
								>
									<X className="w-4 h-4" />
								</button>
							</form>
						);
					}

					if (confirming === v.id) {
						return (
							<div key={v.id} className="px-1 py-1.5 space-y-2">
								<p className="text-xs text-muted-foreground">
									<Trans>
										Delete this vault from this device? Synced copies on your other devices aren't
										affected, and this can't be undone here.
									</Trans>
								</p>
								<div className="flex gap-2">
									<button
										type="button"
										onClick={() => {
											void remove(v.id);
											setConfirming(null);
										}}
										className="px-3 py-1.5 text-xs rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90"
									>
										<Trans>Delete vault</Trans>
									</button>
									<button
										type="button"
										onClick={() => setConfirming(null)}
										className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5"
									>
										<Trans>Cancel</Trans>
									</button>
								</div>
							</div>
						);
					}

					return (
						<div key={v.id} className="flex items-center gap-2 px-1 py-1.5">
							<span className="flex-none w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
								<Vault className="w-4 h-4" />
							</span>
							<span className="flex-1 min-w-0">
								<span className="block text-sm truncate">{label}</span>
								<span className="block text-xs text-muted-foreground">
									{isCurrent && <Trans>Current</Trans>}
									{isCurrent && isPrimary && " · "}
									{isPrimary && <Trans>Primary</Trans>}
									{!isCurrent &&
										!isPrimary &&
										t`Created ${new Date(v.createdAt).toLocaleDateString()}`}
								</span>
							</span>
							<button
								type="button"
								onClick={() => void setPrimaryVault(v.id)}
								disabled={isPrimary}
								className={iconBtn}
								aria-label={t`Make primary`}
								title={t`Make primary`}
							>
								<Star className={`w-4 h-4 ${isPrimary ? "fill-primary text-primary" : ""}`} />
							</button>
							<button
								type="button"
								onClick={() => {
									setDraft(v.label);
									setEditing(v.id);
								}}
								className={iconBtn}
								aria-label={t`Rename`}
								title={t`Rename`}
							>
								<Pencil className="w-4 h-4" />
							</button>
							<button
								type="button"
								onClick={() => setConfirming(v.id)}
								disabled={isCurrent}
								className={iconBtn}
								aria-label={t`Delete`}
								title={isCurrent ? t`You can't delete the vault you're in` : t`Delete`}
							>
								<Trash2 className="w-4 h-4" />
							</button>
						</div>
					);
				})}
			</div>

			<div className="flex flex-wrap gap-2 pt-1">
				<button
					type="button"
					onClick={() => void shell.openSetup()}
					className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-primary/5 flex items-center gap-2"
				>
					<Plus className="w-4 h-4" />
					<Trans>Create new vault</Trans>
				</button>
				{vaults.length > 1 && (
					<button
						type="button"
						onClick={() => void switchVault()}
						className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-primary/5 flex items-center gap-2"
					>
						<ArrowRightLeft className="w-4 h-4" />
						<Trans>Switch vault</Trans>
					</button>
				)}
			</div>
		</Section>
	);
}
