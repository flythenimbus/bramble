import { useLingui } from "@lingui/react/macro";
import { ChevronRight } from "lucide-react";
import { useVaultRegistry } from "../../hooks/useVaultRegistry";
import { formatDate } from "../../util/format-date";
import { displayLabel } from "../../vault/vault-registry";
import { Button } from "./ui/button";

/** Up-to-two-letter avatar initials for a vault label. */
export function initials(label: string): string {
	const words = label.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "V";
	if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
	return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/**
 * The vault rows, shared by the launch-time picker and the import screen so a user choosing
 * where a credential transfer lands sees the same list they know from unlocking.
 */
export function VaultChoiceList({ onSelect }: { onSelect: (id: string) => void }) {
	const { vaults } = useVaultRegistry();
	const { t } = useLingui();

	return (
		<div className="space-y-3">
			{vaults.map((v, i) => {
				const label = displayLabel(v.label, i);
				return (
					<Button
						key={v.id}
						variant="secondary"
						size="none"
						fullWidth
						onClick={() => onSelect(v.id)}
						className="group flex gap-3 rounded-xl border-border/60 bg-card/50 backdrop-blur-sm p-4 text-left hover:bg-primary/5 active:scale-[0.99]"
					>
						<span className="flex-none w-11 h-11 rounded-full bg-primary/10 text-primary text-sm font-medium flex items-center justify-center">
							{initials(label)}
						</span>
						<span className="flex-1 min-w-0">
							<span className="block text-sm text-foreground truncate">{label}</span>
							<span className="block text-xs text-muted-foreground">
								{t`Created on ${formatDate(v.createdAt)}`}
							</span>
						</span>
						<ChevronRight className="flex-none w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
					</Button>
				);
			})}
		</div>
	);
}
