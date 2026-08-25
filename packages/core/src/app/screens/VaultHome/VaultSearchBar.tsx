import { useLingui } from "@lingui/react/macro";
import {
	Archive,
	ArrowUpDown,
	ChevronDown,
	ListFilter,
	type LucideIcon,
	Search,
} from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { Button } from "../../components/ui/button";
import { ScrollEdgeFades, useScrollEdges } from "../../components/ui/scroll-edges";
import { TextField } from "../../components/ui/text-field";
import type { SortKey, TypeFilter, VaultSearch } from "./vault-search";

interface VaultSearchBarProps {
	search: VaultSearch;
	onChange: (patch: Partial<VaultSearch>) => void;
	/**
	 * How many entries are archived. The archive toggle appears only once there is
	 * something in there (or while the archive is open), so a vault that never uses the
	 * feature keeps a two-control bar. Discovery happens at the entry, where the archive
	 * action lives.
	 */
	archivedCount: number;
	/** Rendered to the right of the search input (the add-entry control). */
	trailing?: ReactNode;
}

interface SelectPillProps<T extends string> {
	icon: LucideIcon;
	label: string;
	value: T;
	options: { value: T; label: string }[];
	onChange: (value: T) => void;
	className?: string;
}

/**
 * A compact one-of-N control: an icon, the chosen option, a chevron.
 *
 * The native select is the invisible layer on top, because a visible one is
 * sized by its widest option and in a language like Spanish that took most of
 * the row (leaving the filters stacked one per line). The painted label
 * truncates instead, and tapping anywhere still opens the platform's own picker.
 */
function SelectPill<T extends string>({
	icon: Icon,
	label,
	value,
	options,
	onChange,
	className = "",
}: SelectPillProps<T>) {
	const current = options.find((o) => o.value === value)?.label ?? "";
	return (
		<div
			className={`relative flex items-center gap-1.5 rounded-full border border-border/50 py-1 pl-2.5 pr-2 text-xs text-muted-foreground transition-colors hover:text-foreground hover:border-border focus-within:border-primary ${className}`}
		>
			<Icon className="w-3.5 h-3.5 shrink-0" />
			{/* flex-1: the chevron sits at the edge, as it would on a real select. */}
			<span className="flex-1 truncate text-left">{current}</span>
			<ChevronDown className="w-3.5 h-3.5 shrink-0" />
			<select
				value={value}
				onChange={(e) => onChange(e.target.value as T)}
				aria-label={label}
				className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
			>
				{options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		</div>
	);
}

/** Vault-list controls: text search, a type filter, the sort order, and the archive toggle. */
export function VaultSearchBar({ search, onChange, archivedCount, trailing }: VaultSearchBarProps) {
	const { t } = useLingui();
	const chipStrip = useScrollEdges<HTMLDivElement>();

	const typeOptions: { value: TypeFilter; label: string }[] = [
		{ value: "all", label: t`All` },
		{ value: "login", label: t`Logins` },
		{ value: "card", label: t`Cards` },
		{ value: "note", label: t`Notes` },
		{ value: "ssh-key", label: t`Keys` },
	];

	const sortOptions: { value: SortKey; label: string }[] = [
		{ value: "name-asc", label: t`Name A-Z` },
		{ value: "name-desc", label: t`Name Z-A` },
		{ value: "recent-used", label: t`Recently used` },
		{ value: "recent-added", label: t`Recently added` },
		{ value: "recent-updated", label: t`Recently updated` },
	];

	// The chips only ever scroll on a narrow desktop window or a long-worded
	// locale, and a chip scrolled out of sight reads as no filter at all.
	useEffect(() => {
		const strip = chipStrip.ref.current;
		const active = strip?.querySelector<HTMLElement>(`[data-type="${search.type}"]`);
		if (!strip || !active) return;
		strip.scrollLeft = active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2;
	}, [search.type, chipStrip.ref]);

	return (
		<div className="mb-4 space-y-2.5">
			<div className="flex gap-2 items-stretch">
				<div className="flex-1">
					<TextField
						label={t`Search vault`}
						type="text"
						value={search.q}
						onChange={(e) => onChange({ q: e.target.value })}
						startAdornment={<Search className="w-4 h-4" />}
					/>
				</div>
				{trailing}
			</div>

			<div className="flex items-center gap-2">
				{/* Two controls of the same kind on a phone: the type filter is one
					choice from a closed set, exactly what the sort control is, and the
					five labels don't fit on a phone in any language we ship. Chips win
					wherever they all fit, so they take over from `sm` up. */}
				<SelectPill
					icon={ListFilter}
					label={t`Filter by type`}
					value={search.type}
					options={typeOptions}
					onChange={(type) => onChange({ type })}
					className="sm:hidden min-w-0 flex-1"
				/>

				<fieldset
					className="relative hidden sm:block flex-1 min-w-0 border-0 p-0 m-0"
					aria-label={t`Filter by type`}
				>
					<div
						ref={chipStrip.ref}
						// overflow-y-hidden + touch-pan-x: horizontal only, so a vertical drag scrolls the list.
						className="flex items-center gap-1.5 overflow-x-auto overflow-y-hidden touch-pan-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
					>
						{typeOptions.map((chip) => {
							const active = search.type === chip.value;
							return (
								<Button
									key={chip.value}
									variant="link"
									size="none"
									data-type={chip.value}
									onClick={() => onChange({ type: chip.value })}
									aria-pressed={active}
									className={`shrink-0 whitespace-nowrap px-2.5 py-1 rounded-full text-xs border transition-colors ${
										active
											? "bg-primary/15 border-primary/40 text-foreground"
											: "border-border/50 text-muted-foreground hover:text-foreground hover:border-border"
									}`}
								>
									{chip.label}
								</Button>
							);
						})}
					</div>
					<ScrollEdgeFades edges={chipStrip.edges} />
				</fieldset>

				<SelectPill
					icon={ArrowUpDown}
					label={t`Sort`}
					value={search.sort}
					options={sortOptions}
					onChange={(sort) => onChange({ sort })}
					className="min-w-0 flex-1 sm:flex-none sm:shrink-0"
				/>

				{(archivedCount > 0 || search.archived) && (
					<Button
						variant="link"
						size="none"
						onClick={() => onChange({ archived: !search.archived })}
						aria-pressed={search.archived}
						aria-label={t`Show archived items`}
						title={t`Archived items`}
						className={`shrink-0 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors pointer-coarse:py-2 ${
							search.archived
								? "bg-primary/15 border-primary/40 text-foreground"
								: "border-border/50 text-muted-foreground hover:text-foreground hover:border-border"
						}`}
					>
						<Archive className="w-3.5 h-3.5 shrink-0" />
						{/* The count is the point of the resting state: it says the archive is not
							empty without the user having to open it. */}
						<span className="tabular-nums">{archivedCount}</span>
					</Button>
				)}
			</div>
		</div>
	);
}
