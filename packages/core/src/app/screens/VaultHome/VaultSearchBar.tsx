import { useLingui } from "@lingui/react/macro";
import { ArrowUpDown, ChevronDown, Search } from "lucide-react";
import type { ReactNode } from "react";
import { TextField } from "../../components/ui/text-field";
import type { SortKey, TypeFilter, VaultSearch } from "./vault-search";

interface VaultSearchBarProps {
	search: VaultSearch;
	onChange: (patch: Partial<VaultSearch>) => void;
	/** Rendered to the right of the search input (the add-entry control). */
	trailing?: ReactNode;
}

/** Vault-list controls: text search, a type filter, and the sort order. */
export function VaultSearchBar({ search, onChange, trailing }: VaultSearchBarProps) {
	const { t } = useLingui();

	const typeChips: { value: TypeFilter; label: string }[] = [
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

			<div className="flex items-start gap-2">
				<fieldset
					className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap border-0 p-0 m-0"
					aria-label={t`Filter by type`}
				>
					{typeChips.map((chip) => {
						const active = search.type === chip.value;
						return (
							<button
								key={chip.value}
								type="button"
								onClick={() => onChange({ type: chip.value })}
								aria-pressed={active}
								className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
									active
										? "bg-primary/15 border-primary/40 text-foreground"
										: "border-border/50 text-muted-foreground hover:text-foreground hover:border-border"
								}`}
							>
								{chip.label}
							</button>
						);
					})}
				</fieldset>

				{/* Compact pill-height sort control, inline with the filter chips. */}
				<div className="relative shrink-0">
					<ArrowUpDown className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
					<select
						value={search.sort}
						onChange={(e) => onChange({ sort: e.target.value as SortKey })}
						aria-label={t`Sort`}
						className="appearance-none cursor-pointer rounded-full border border-border/50 bg-transparent pl-8 pr-7 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground hover:border-border focus:outline-none focus:border-primary"
					>
						{sortOptions.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
					<ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
				</div>
			</div>
		</div>
	);
}
