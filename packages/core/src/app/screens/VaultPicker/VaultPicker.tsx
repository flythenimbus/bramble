import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronRight, Plus } from "lucide-react";
import { usePlatform } from "../../../context/PlatformContext";
import { useVaultRegistry } from "../../../hooks/useVaultRegistry";
import { displayLabel } from "../../../vault/vault-registry";
import { BrambleGlyph } from "../../components/BrambleGlyph";

/** Up-to-two-letter avatar initials for a vault label. */
function initials(label: string): string {
	const words = label.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "V";
	if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
	return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** Launch-time vault chooser, shown when more than one vault exists (see routing guards). */
export function VaultPicker() {
	const { vaults, selectVault } = useVaultRegistry();
	const { shell } = usePlatform();
	const { t } = useLingui();

	return (
		<div className="relative min-h-screen overflow-y-auto bg-linear-to-br from-background via-background to-primary/5 flex items-center justify-center p-6">
			<div className="w-full max-w-md">
				<div className="text-center mb-6">
					<BrambleGlyph className="w-14 h-14 text-foreground mb-3 inline-block" />
					<h1 className="text-xl bg-linear-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
						<Trans>Choose a vault to unlock</Trans>
					</h1>
				</div>

				<div className="space-y-3">
					{vaults.map((v, i) => {
						const label = displayLabel(v.label, i);
						return (
							<button
								key={v.id}
								type="button"
								onClick={() => selectVault(v.id)}
								className="group w-full flex items-center gap-3 rounded-xl border border-border/60 bg-card/50 backdrop-blur-sm p-4 text-left hover:border-primary/50 hover:bg-primary/5 active:scale-[0.99] transition-all"
							>
								<span className="flex-none w-11 h-11 rounded-full bg-primary/10 text-primary text-sm font-medium flex items-center justify-center">
									{initials(label)}
								</span>
								<span className="flex-1 min-w-0">
									<span className="block text-sm text-foreground truncate">{label}</span>
									<span className="block text-xs text-muted-foreground">
										{t`Created ${new Date(v.createdAt).toLocaleDateString()}`}
									</span>
								</span>
								<ChevronRight className="flex-none w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
							</button>
						);
					})}

					<button
						type="button"
						onClick={() => void shell.openSetup()}
						className="w-full flex items-center gap-3 rounded-xl border border-dashed border-border/70 p-4 text-left text-muted-foreground hover:border-primary/50 hover:text-foreground active:scale-[0.99] transition-all"
					>
						<span className="flex-none w-11 h-11 rounded-full bg-primary/10 text-primary flex items-center justify-center">
							<Plus className="w-5 h-5" />
						</span>
						<span className="flex-1 text-sm">
							<Trans>Create new vault</Trans>
						</span>
					</button>
				</div>
			</div>
		</div>
	);
}
