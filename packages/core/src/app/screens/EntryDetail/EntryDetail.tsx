import { AlertTriangle, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { usePlatform } from "../../../context/PlatformContext";
import type { Entry } from "../../../hooks/useVault";
import { getEntryMode } from "../../entry-modes";
import { CustomFieldsDetail } from "../../entry-modes/custom-fields";

interface EntryDetailProps {
	entry: Entry;
	onEdit: () => void;
	onDelete: () => Promise<void>;
}

/** Shared chrome for viewing any entry (banner, header, delete/edit footer); the mode supplies the fields. */
export function EntryDetail({ entry, onEdit, onDelete }: EntryDetailProps) {
	const { clipboard } = usePlatform();
	const [copied, setCopied] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [deleting, setDeleting] = useState(false);

	const mode = getEntryMode(entry.type);
	const { icon: Icon, initials } = mode.row(entry);
	const subtitle = mode.detailSubtitle?.(entry);
	const alert = mode.detailAlert?.(entry) ?? null;
	const Detail = mode.Detail;

	useEffect(() => {
		if (!copied) return;
		const id = setTimeout(() => setCopied(null), 1500);
		return () => clearTimeout(id);
	}, [copied]);

	const copy = async (label: string, value: string) => {
		try {
			await clipboard.copy(value);
			setCopied(label);
		} catch {
			// Clipboard write can fail when the document isn't focused. Best-effort.
		}
	};

	const handleDelete = async () => {
		setDeleting(true);
		try {
			await onDelete();
		} finally {
			setDeleting(false);
		}
	};

	return (
		<main className="max-w-5xl mx-auto px-4 py-3">
			{alert && (
				<div
					className="mb-3 flex items-start gap-2.5 px-4 py-2.5 rounded-lg border border-destructive/40 bg-destructive/10 text-destructive"
					role="alert"
				>
					<AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
					<div className="text-sm">
						<p className="font-medium">{alert.title}</p>
						<p className="text-xs mt-0.5 opacity-90">{alert.body}</p>
					</div>
				</div>
			)}

			<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
				<div className="p-4 space-y-3">
					<div className="flex items-center gap-3">
						<div className="flex items-center justify-center w-10 h-10 rounded-lg bg-linear-to-br from-primary/20 to-primary/10 shadow-sm shrink-0">
							{initials ? (
								<span className="text-sm text-primary">{initials}</span>
							) : (
								<Icon className="w-4 h-4 text-primary" />
							)}
						</div>
						<div className="min-w-0 flex-1">
							<h2 className="text-base truncate">{entry.name}</h2>
							{subtitle && <p className="text-xs text-muted-foreground truncate">{subtitle}</p>}
						</div>
						<div className="flex items-center gap-1 shrink-0">
							<button
								type="button"
								onClick={onEdit}
								className="p-2 rounded-lg border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
								aria-label="Edit entry"
								title="Edit"
							>
								<Pencil className="w-4 h-4" />
							</button>
							<button
								type="button"
								onClick={() => setConfirmDelete(true)}
								className="p-2 rounded-lg border border-transparent hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 active:scale-[0.95] transition-all"
								aria-label="Delete entry"
								title="Delete"
							>
								<Trash2 className="w-4 h-4" />
							</button>
						</div>
					</div>

					<Detail entry={entry} copied={copied} copy={copy} />

					{entry.customFields && entry.customFields.length > 0 && (
						<CustomFieldsDetail fields={entry.customFields} copied={copied} copy={copy} />
					)}
				</div>

				{confirmDelete && (
					<div className="p-4 bg-muted/30 border-t border-border/50 flex items-center justify-between gap-3">
						<p className="flex-1 text-xs text-destructive">Delete this entry permanently?</p>
						<button
							type="button"
							onClick={() => setConfirmDelete(false)}
							disabled={deleting}
							className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-background/50 active:scale-[0.98] transition-all disabled:opacity-50"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={handleDelete}
							disabled={deleting}
							className="px-5 py-2 text-sm rounded-lg bg-destructive text-destructive-foreground border border-destructive/20 hover:bg-destructive/90 active:scale-[0.98] transition-all disabled:opacity-50"
						>
							{deleting ? "Deleting…" : "Delete"}
						</button>
					</div>
				)}
			</div>
		</main>
	);
}
