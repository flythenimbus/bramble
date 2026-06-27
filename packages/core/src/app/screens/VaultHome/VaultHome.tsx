import { Trans, useLingui } from "@lingui/react/macro";
import { type LucideIcon, Search, TrendingDown, TrendingUp } from "lucide-react";
import { useState } from "react";
import type { EntryType } from "../../../hooks/useVault";
import { AddDropdown } from "../../components/AddDropdown";
import { EntryRow } from "../../components/EntryRow";
import { TextField } from "../../components/ui/text-field";

/** List-ready projection of an entry: shared id/name plus mode-contributed display fields. */
export interface VaultListItem {
	id: string;
	type: EntryType;
	name: string;
	icon: LucideIcon;
	initials?: string;
	secondary: string;
	leaked?: boolean;
	copyItems: { label: string; value: string }[];
	// Lowercased text the search box matches against.
	searchText: string;
}

interface VaultHomeProps {
	items: VaultListItem[];
	onCreate: (type: EntryType) => void;
	onSelectEntry: (id: string) => void;
	onEditEntry: (id: string) => void;
	onDeleteEntry: (id: string) => Promise<void>;
}

/** Vault list screen with search, password-health stats, and the entry rows. */
export function VaultHome({
	items,
	onCreate,
	onSelectEntry,
	onEditEntry,
	onDeleteEntry,
}: VaultHomeProps) {
	const { t } = useLingui();
	const [searchQuery, setSearchQuery] = useState("");

	const query = searchQuery.toLowerCase();
	const filtered = items.filter((item) => item.searchText.includes(query));

	// "At Risk" / "Strong" are password-health stats, so they count logins only.
	const atRisk = items.filter((item) => item.leaked).length;
	const strong = items.filter((item) => item.type === "login" && !item.leaked).length;

	return (
		<main className="flex-1 min-h-0 flex flex-col w-full max-w-5xl mx-auto px-4 py-5">
			<div className="flex gap-2 mb-5 items-stretch">
				<div className="flex-1">
					<TextField
						label={t`Search vault`}
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						startAdornment={<Search className="w-4 h-4" />}
					/>
				</div>
				<AddDropdown onCreate={onCreate} />
			</div>

			<div className="grid grid-cols-3 gap-3 mb-5">
				<div className="relative overflow-hidden px-4 py-3 rounded-lg border border-border/50 bg-linear-to-br from-card to-background backdrop-blur-sm">
					<div className="absolute inset-0 bg-linear-to-br from-primary/5 to-transparent opacity-50"></div>
					<div className="relative">
						<p className="text-xs text-muted-foreground mb-0.5">
							<Trans>Total Items</Trans>
						</p>
						<p className="text-2xl">{items.length}</p>
					</div>
				</div>
				<div className="relative overflow-hidden px-4 py-3 rounded-lg border border-border/50 bg-linear-to-br from-card to-background backdrop-blur-sm">
					<div className="absolute inset-0 bg-linear-to-br from-destructive/5 to-transparent opacity-50"></div>
					<div className="relative">
						<div className="flex items-center gap-1.5 mb-0.5">
							<p className="text-xs text-muted-foreground">
								<Trans>At Risk</Trans>
							</p>
							<TrendingDown className="w-3 h-3 text-destructive" />
						</div>
						<p className="text-2xl text-destructive">{atRisk}</p>
					</div>
				</div>
				<div className="relative overflow-hidden px-4 py-3 rounded-lg border border-border/50 bg-linear-to-br from-card to-background backdrop-blur-sm">
					<div className="absolute inset-0 bg-linear-to-br from-primary/5 to-transparent opacity-50"></div>
					<div className="relative">
						<div className="flex items-center gap-1.5 mb-0.5">
							<p className="text-xs text-muted-foreground">
								<Trans>Strong</Trans>
							</p>
							<TrendingUp className="w-3 h-3 text-primary" />
						</div>
						<p className="text-2xl text-primary">{strong}</p>
					</div>
				</div>
			</div>

			<div className="flex-1 min-h-0 flex flex-col rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
				<div className="shrink-0 px-4 py-3 border-b border-border/50 flex items-center justify-between">
					<h3 className="text-sm">
						<Trans>Items ({filtered.length})</Trans>
					</h3>
					<button
						type="button"
						className="text-xs text-muted-foreground hover:text-foreground active:scale-[0.98] transition-all"
					>
						<Trans>Sort by name</Trans>
					</button>
				</div>
				<div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
					{filtered.length > 0 ? (
						filtered.map((item) => (
							<EntryRow
								key={item.id}
								name={item.name}
								secondary={item.secondary}
								icon={item.icon}
								initials={item.initials}
								leaked={item.leaked}
								copyItems={item.copyItems}
								onSelect={() => onSelectEntry(item.id)}
								onEdit={() => onEditEntry(item.id)}
								onDelete={() => onDeleteEntry(item.id)}
							/>
						))
					) : (
						<div className="text-center py-12 text-muted-foreground text-sm">
							<Trans>No items found matching your search.</Trans>
						</div>
					)}
				</div>
			</div>
		</main>
	);
}
