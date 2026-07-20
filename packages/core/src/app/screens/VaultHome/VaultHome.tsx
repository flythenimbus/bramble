import { Trans } from "@lingui/react/macro";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, type LucideIcon, TrendingDown, TrendingUp } from "lucide-react";
import { useRef } from "react";
import type { EntryType } from "../../../hooks/useVault";
import { AddDropdown } from "../../components/AddDropdown";
import { EntryRow } from "../../components/EntryRow";
import { VaultSearchBar } from "./VaultSearchBar";
import { filterAndSortEntries, type VaultSearch } from "./vault-search";

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
	createdAt?: number;
	updatedAt?: number;
	lastUsedAt?: number;
}

interface VaultHomeProps {
	items: VaultListItem[];
	search: VaultSearch;
	onSearchChange: (patch: Partial<VaultSearch>) => void;
	/** Ids matching the current site; floated to the top and tinted. */
	matchedIds?: ReadonlySet<string>;
	onCreate: (type: EntryType) => void;
	onSelectEntry: (id: string) => void;
	onEditEntry: (id: string) => void;
	onDeleteEntry: (id: string) => Promise<void>;
	onUseEntry: (id: string) => void;
	/** Home stats row: collapsed state + toggle, both persisted in prefs. */
	statsCollapsed: boolean;
	onToggleStats: () => void;
}

/** Vault list screen with search, password-health stats, and the entry rows. */
export function VaultHome({
	items,
	search,
	onSearchChange,
	matchedIds,
	onCreate,
	onSelectEntry,
	onEditEntry,
	onDeleteEntry,
	onUseEntry,
	statsCollapsed,
	onToggleStats,
}: VaultHomeProps) {
	const filtered = filterAndSortEntries(items, search, matchedIds);

	// "At Risk" / "Strong" are password-health stats, so they count logins only.
	const atRisk = items.filter((item) => item.leaked).length;
	const strong = items.filter((item) => item.type === "login" && !item.leaked).length;

	// Virtualize the row list so a large vault (1000+ entries) mounts only the
	// visible rows, not every EntryRow at once (the main open-time render cost).
	const scrollRef = useRef<HTMLDivElement>(null);
	const rowVirtualizer = useVirtualizer({
		count: filtered.length,
		getScrollElement: () => scrollRef.current,
		// Rows are a uniform ~56px; +4 folds in the gap that was `space-y-1`.
		// measureElement corrects any drift from the real rendered height.
		estimateSize: () => 60,
		overscan: 8,
		getItemKey: (index) => filtered[index]?.id ?? index,
	});

	return (
		<main className="flex-1 min-h-0 flex flex-col w-full max-w-5xl mx-auto px-4 py-5">
			<VaultSearchBar
				search={search}
				onChange={onSearchChange}
				trailing={<AddDropdown onCreate={onCreate} />}
			/>

			<button
				type="button"
				onClick={onToggleStats}
				aria-expanded={!statsCollapsed}
				className="mb-3 flex w-full items-center justify-between px-1 py-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
			>
				<Trans>Overview</Trans>
				<ChevronDown
					className={`w-4 h-4 transition-transform duration-200 ${statsCollapsed ? "" : "rotate-180"}`}
				/>
			</button>

			{!statsCollapsed && (
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
			)}

			<div className="flex-1 min-h-0 flex flex-col rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
				<div className="shrink-0 px-4 py-3 border-b border-border/50">
					<h3 className="text-sm">
						<Trans>Items ({filtered.length})</Trans>
					</h3>
				</div>
				<div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-2">
					{filtered.length > 0 ? (
						<div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
							{rowVirtualizer.getVirtualItems().map((row) => {
								const item = filtered[row.index];
								if (!item) return null;
								return (
									<div
										key={row.key}
										data-index={row.index}
										ref={rowVirtualizer.measureElement}
										className="absolute top-0 left-0 w-full pb-1"
										style={{ transform: `translateY(${row.start}px)` }}
									>
										<EntryRow
											name={item.name}
											secondary={item.secondary}
											icon={item.icon}
											initials={item.initials}
											leaked={item.leaked}
											copyItems={item.copyItems}
											onSelect={() => onSelectEntry(item.id)}
											onEdit={() => onEditEntry(item.id)}
											onDelete={() => onDeleteEntry(item.id)}
											onUse={() => onUseEntry(item.id)}
											highlighted={matchedIds?.has(item.id)}
										/>
									</div>
								);
							})}
						</div>
					) : (
						<div className="text-center py-12 text-muted-foreground text-sm">
							{items.length === 0 ? (
								<Trans>Your vault is empty. Add your first item.</Trans>
							) : (
								<Trans>No items found matching your search.</Trans>
							)}
						</div>
					)}
				</div>
			</div>
		</main>
	);
}
