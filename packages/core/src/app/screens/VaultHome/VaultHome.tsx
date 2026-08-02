import { Trans, useLingui } from "@lingui/react/macro";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ListChecks, type LucideIcon, TrendingDown, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Entry, EntryType } from "../../../hooks/useVault";
import { AddDropdown } from "../../components/AddDropdown";
import { EntryRow } from "../../components/EntryRow";
import { Button } from "../../components/ui/button";
import type { CopyItem } from "../../entry-modes/types";
import { SelectionBar } from "./SelectionBar";
import {
	allSelected,
	EMPTY_SELECTION,
	hiddenSelectedCount,
	pruneSelection,
	type Selection,
	selectAll,
	toggleSelected,
} from "./selection";
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
	passkeys?: number;
	copyItems: CopyItem[];
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
	/**
	 * The decrypted entries behind `items`. Bulk actions run on real entries (an export
	 * needs the secrets, a delete needs the passkey count), which a list projection drops.
	 */
	entries: Entry[];
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
	entries,
	onUseEntry,
	statsCollapsed,
	onToggleStats,
}: VaultHomeProps) {
	const { t } = useLingui();
	const filtered = filterAndSortEntries(items, search, matchedIds);

	// Bulk selection. An explicit mode, not one derived from `selected.size`: emptying
	// the selection is a normal thing to do mid-edit and must not throw the user out.
	// Entered from the header button, or by long-press on touch.
	const [selected, setSelected] = useState<Selection>(EMPTY_SELECTION);
	const [selectMode, setSelectMode] = useState(false);

	// An entry can leave under the selection: deleted here, or dropped by a sync
	// merge while the list is open. Identity-stable, so a no-op doesn't re-render.
	useEffect(() => {
		setSelected((prev) => pruneSelection(prev, items));
	}, [items]);

	const exitSelection = () => {
		setSelected(EMPTY_SELECTION);
		setSelectMode(false);
	};

	// Actions run on real entries, not the list projection. Filtering `entries` (not
	// mapping `selected`) keeps them in vault order and drops ids a sync merge removed.
	const selectedEntries = useMemo(
		() => entries.filter((e) => selected.has(e.id)),
		[entries, selected],
	);

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
				{selectMode ? (
					<SelectionBar
						selectedEntries={selectedEntries}
						hiddenCount={hiddenSelectedCount(selected, filtered)}
						allVisibleSelected={allSelected(selected, filtered)}
						onSelectAll={() => setSelected((prev) => selectAll(prev, filtered))}
						onDeselectAll={() => setSelected(EMPTY_SELECTION)}
						onExit={exitSelection}
						// Clears the selection but stays in selection mode: finishing one action
						// is usually the middle of a cleanup pass, not the end of it.
						onActionDone={() => setSelected(EMPTY_SELECTION)}
					/>
				) : (
					<div className="shrink-0 px-4 py-2 border-b border-border/50 flex items-center justify-between gap-3">
						<h3 className="text-sm">
							<Trans>Items ({filtered.length})</Trans>
						</h3>
						{/* The only way into selection mode on a pointer surface; touch also has
							long-press. Nothing to select in an empty list. */}
						<Button
							variant="ghost"
							size="icon"
							onClick={() => setSelectMode(true)}
							disabled={filtered.length === 0}
							aria-label={t`Select items`}
							title={t`Select items`}
							// Matches the exit button in SelectionBar, so the header keeps one
							// height across both modes.
							className="pointer-coarse:p-3.5"
						>
							<ListChecks className="w-4 h-4" />
						</Button>
					</div>
				)}
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
										// has-[[data-menu-open]]:z-10 lifts the row whose dropdown is open above the
										// rows below it. Each row is transform-positioned (its own stacking
										// context), so a z-index inside the row can't clear its neighbours.
										className="absolute top-0 left-0 w-full pb-1 has-[[data-menu-open]]:z-10"
										style={{ transform: `translateY(${row.start}px)` }}
									>
										<EntryRow
											name={item.name}
											secondary={item.secondary}
											icon={item.icon}
											initials={item.initials}
											leaked={item.leaked}
											passkeys={item.passkeys}
											copyItems={item.copyItems}
											onSelect={() => onSelectEntry(item.id)}
											onEdit={() => onEditEntry(item.id)}
											onDelete={() => onDeleteEntry(item.id)}
											onUse={() => onUseEntry(item.id)}
											highlighted={matchedIds?.has(item.id)}
											selectMode={selectMode}
											selected={selected.has(item.id)}
											onToggleSelect={() => setSelected((prev) => toggleSelected(prev, item.id))}
											// Long-press selects the row it started on, so the gesture and its
											// first selection are one action.
											onLongPress={() => {
												setSelectMode(true);
												setSelected((prev) => toggleSelected(prev, item.id));
											}}
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
