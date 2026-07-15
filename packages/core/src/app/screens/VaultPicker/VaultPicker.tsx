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

const rowClass =
	"w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-primary/5 active:scale-[0.99] transition-all";

/** Launch-time vault chooser, shown when more than one vault exists (see routing guards). */
export function VaultPicker() {
	const { vaults, selectVault } = useVaultRegistry();
	const { shell } = usePlatform();
	const { t } = useLingui();

	return (
		<div className="relative h-screen overflow-y-auto bg-linear-to-br from-background via-background to-primary/5">
			<div className="px-6 py-6">
				<div className="w-full max-w-md mx-auto">
					<div className="mb-5">
						<div className="flex justify-center mb-3">
							<BrambleGlyph className="w-16 h-16 text-foreground" />
						</div>
						<h1 className="text-xl bg-linear-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
							<Trans>Choose a vault to unlock</Trans>
						</h1>
					</div>

					<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden divide-y divide-border/50">
						{vaults.map((v, i) => {
							const label = displayLabel(v.label, i);
							return (
								<button
									key={v.id}
									type="button"
									onClick={() => selectVault(v.id)}
									className={rowClass}
								>
									<span className="flex-none w-9 h-9 rounded-full bg-primary/10 text-primary text-xs font-medium flex items-center justify-center">
										{initials(label)}
									</span>
									<span className="flex-1 min-w-0">
										<span className="block text-sm text-foreground truncate">{label}</span>
										<span className="block text-xs text-muted-foreground">
											{t`Created ${new Date(v.createdAt).toLocaleDateString()}`}
										</span>
									</span>
									<ChevronRight className="flex-none w-4 h-4 text-muted-foreground" />
								</button>
							);
						})}
						<button type="button" onClick={() => void shell.openSetup()} className={rowClass}>
							<span className="flex-none w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center">
								<Plus className="w-4 h-4" />
							</span>
							<span className="flex-1 text-sm text-foreground">
								<Trans>Create new vault</Trans>
							</span>
							<ChevronRight className="flex-none w-4 h-4 text-muted-foreground" />
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
