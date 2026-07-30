import { Trans } from "@lingui/react/macro";
import { Plus } from "lucide-react";
import { usePlatform } from "../../../context/PlatformContext";
import { useVaultRegistry } from "../../../hooks/useVaultRegistry";
import { BrambleGlyph } from "../../components/BrambleGlyph";
import { Button } from "../../components/ui/button";
import { VaultChoiceList } from "../../components/VaultChoiceList";

/** Launch-time vault chooser, shown when more than one vault exists (see routing guards). */
export function VaultPicker() {
	const { selectVault } = useVaultRegistry();
	const { shell } = usePlatform();

	return (
		<div className="relative h-screen overflow-y-auto bg-linear-to-br from-background via-background to-primary/5">
			<div className="min-h-full flex items-center justify-center p-6">
				<div className="w-full max-w-md">
					<div className="text-center mb-6">
						<BrambleGlyph className="w-14 h-14 text-foreground mb-3 inline-block" />
						<h1 className="text-xl bg-linear-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
							<Trans>Choose a vault to unlock</Trans>
						</h1>
					</div>

					<div className="space-y-3">
						<VaultChoiceList onSelect={selectVault} />
						<Button
							variant="link"
							size="none"
							fullWidth
							onClick={() => void shell.openSetup()}
							className="flex gap-3 rounded-xl border border-dashed border-border/70 p-4 text-left hover:border-primary/50 active:scale-[0.99]"
						>
							<span className="flex-none w-11 h-11 rounded-full bg-primary/10 text-primary flex items-center justify-center">
								<Plus className="w-5 h-5" />
							</span>
							<span className="flex-1 text-sm">
								<Trans>Create new vault</Trans>
							</span>
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
