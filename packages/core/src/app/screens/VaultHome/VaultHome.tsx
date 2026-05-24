import { Search, TrendingDown, TrendingUp } from "lucide-react";
import { useState } from "react";
import { AddDropdown } from "../../components/AddDropdown";
import { PasswordItem } from "../../components/PasswordItem";
import { TextField } from "../../components/ui/text-field";

interface EntrySummary {
	id: string;
	name: string;
	url: string;
	username: string;
	password: string;
	leaked?: boolean;
}

interface VaultHomeProps {
	entries: EntrySummary[];
	onCreateNew: () => void;
	onSelectEntry: (id: string) => void;
	onEditEntry: (id: string) => void;
	onDeleteEntry: (id: string) => Promise<void>;
}

export function VaultHome({
	entries,
	onCreateNew,
	onSelectEntry,
	onEditEntry,
	onDeleteEntry,
}: VaultHomeProps) {
	const [searchQuery, setSearchQuery] = useState("");

	const filtered = entries.filter(
		(p) =>
			p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
			p.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
			p.url.toLowerCase().includes(searchQuery.toLowerCase()),
	);

	const atRisk = entries.filter((p) => p.leaked).length;
	const strong = entries.length - atRisk;

	return (
		<main className="flex-1 min-h-0 flex flex-col w-full max-w-5xl mx-auto px-4 py-5">
			<div className="flex gap-2 mb-5 items-stretch">
				<div className="flex-1">
					<TextField
						label="Search passwords"
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						startAdornment={<Search className="w-4 h-4" />}
					/>
				</div>
				<AddDropdown onCreatePassword={onCreateNew} />
			</div>

			<div className="grid grid-cols-3 gap-3 mb-5">
				<div className="relative overflow-hidden px-4 py-3 rounded-lg border border-border/50 bg-gradient-to-br from-card to-background backdrop-blur-sm">
					<div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-50"></div>
					<div className="relative">
						<p className="text-xs text-muted-foreground mb-0.5">Total Items</p>
						<p className="text-2xl">{entries.length}</p>
					</div>
				</div>
				<div className="relative overflow-hidden px-4 py-3 rounded-lg border border-border/50 bg-gradient-to-br from-card to-background backdrop-blur-sm">
					<div className="absolute inset-0 bg-gradient-to-br from-destructive/5 to-transparent opacity-50"></div>
					<div className="relative">
						<div className="flex items-center gap-1.5 mb-0.5">
							<p className="text-xs text-muted-foreground">At Risk</p>
							<TrendingDown className="w-3 h-3 text-destructive" />
						</div>
						<p className="text-2xl text-destructive">{atRisk}</p>
					</div>
				</div>
				<div className="relative overflow-hidden px-4 py-3 rounded-lg border border-border/50 bg-gradient-to-br from-card to-background backdrop-blur-sm">
					<div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-50"></div>
					<div className="relative">
						<div className="flex items-center gap-1.5 mb-0.5">
							<p className="text-xs text-muted-foreground">Strong</p>
							<TrendingUp className="w-3 h-3 text-primary" />
						</div>
						<p className="text-2xl text-primary">{strong}</p>
					</div>
				</div>
			</div>

			<div className="flex-1 min-h-0 flex flex-col rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
				<div className="shrink-0 px-4 py-3 border-b border-border/50 flex items-center justify-between">
					<h3 className="text-sm">Passwords ({filtered.length})</h3>
					<button
						type="button"
						className="text-xs text-muted-foreground hover:text-foreground active:scale-[0.98] transition-all"
					>
						Sort by name
					</button>
				</div>
				<div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
					{filtered.length > 0 ? (
						filtered.map((pwd) => (
							<PasswordItem
								key={pwd.id}
								name={pwd.name}
								username={pwd.username}
								password={pwd.password}
								url={pwd.url}
								leaked={pwd.leaked}
								onSelect={() => onSelectEntry(pwd.id)}
								onEdit={() => onEditEntry(pwd.id)}
								onDelete={() => onDeleteEntry(pwd.id)}
							/>
						))
					) : (
						<div className="text-center py-12 text-muted-foreground text-sm">
							No passwords found matching your search.
						</div>
					)}
				</div>
			</div>
		</main>
	);
}
