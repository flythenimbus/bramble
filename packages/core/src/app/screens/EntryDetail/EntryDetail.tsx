import { Trans, useLingui } from "@lingui/react/macro";
import { AlertTriangle, Archive, ArchiveRestore, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { usePlatform } from "../../../context/PlatformContext";
import type { ConflictChoice, ConflictVersion, Entry } from "../../../hooks/useVault";
import type { EntryConflict } from "../../../sync";
import { formatDateTime } from "../../../util/format-date";
import { Button } from "../../components/ui/button";
import { getEntryMode } from "../../entry-modes";
import { AttachmentsDetail } from "../../entry-modes/attachments";
import { CustomFieldsDetail } from "../../entry-modes/custom-fields";
import { TagsDetail } from "../../entry-modes/tags";
import { ConflictBanner } from "./ConflictBanner";

interface EntryDetailProps {
	entry: Entry;
	onEdit: () => void;
	onDelete: () => Promise<void>;
	/** Archive or restore this entry. Reversible, so it runs without a confirmation step. */
	onSetArchived: (archived: boolean) => Promise<void>;
	/** Show every entry carrying this tag. */
	onSelectTag: (tag: string) => void;
	/** Called after a successful field copy, to record the entry as recently used. */
	onUse?: () => void;
	/** Sync kept other versions of this entry, or a concurrent delete (docs/sync-conflicts.md). */
	conflict?: EntryConflict;
	onReadConflictVersions?: () => Promise<ConflictVersion[]>;
	onResolveConflict?: (choice: ConflictChoice) => Promise<void>;
}

/** Shared chrome for viewing any entry (banner, Edit header, archive/delete footer); the mode supplies the fields. */
export function EntryDetail({
	entry,
	onEdit,
	onDelete,
	onSetArchived,
	onSelectTag,
	onUse,
	conflict,
	onReadConflictVersions,
	onResolveConflict,
}: EntryDetailProps) {
	const { clipboard } = usePlatform();
	const { t } = useLingui();
	const [copied, setCopied] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [archiving, setArchiving] = useState(false);
	const archived = entry.archivedAt !== undefined;

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
			onUse?.();
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

	// Stays on this screen afterwards rather than returning to the list: the banner then
	// explains what happened, and restoring is one tap away instead of a hunt through the
	// archive for the entry that just vanished.
	const handleSetArchived = async () => {
		setArchiving(true);
		try {
			await onSetArchived(!archived);
		} finally {
			setArchiving(false);
		}
	};

	return (
		<main className="max-w-5xl mx-auto px-4 py-3">
			{archived && (
				<div
					className="mb-3 flex items-start gap-2.5 px-4 py-2.5 rounded-lg border border-border/50 bg-muted/40 text-muted-foreground"
					role="status"
				>
					<Archive className="w-4 h-4 mt-0.5 shrink-0" />
					<div className="text-sm">
						<p className="font-medium text-foreground">
							<Trans>Archived</Trans>
						</p>
						<p className="text-xs mt-0.5">
							<Trans>
								Kept in your vault, but hidden from the list and never offered for autofill.
							</Trans>
						</p>
					</div>
				</div>
			)}

			{conflict && onReadConflictVersions && onResolveConflict && (
				<ConflictBanner
					entry={entry}
					conflict={conflict}
					onReadVersions={onReadConflictVersions}
					onResolve={onResolveConflict}
					onDelete={onDelete}
				/>
			)}

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
						<Button
							variant="secondary"
							onClick={onEdit}
							aria-label={t`Edit entry`}
							className="shrink-0 gap-1.5 px-3"
						>
							<Pencil className="w-4 h-4" />
							<Trans>Edit</Trans>
						</Button>
					</div>

					<Detail entry={entry} copied={copied} copy={copy} />

					{entry.customFields && entry.customFields.length > 0 && (
						<CustomFieldsDetail fields={entry.customFields} copied={copied} copy={copy} />
					)}

					<AttachmentsDetail entryId={entry.id} />

					{entry.tags && entry.tags.length > 0 && (
						<TagsDetail tags={entry.tags} onSelect={onSelectTag} />
					)}
				</div>

				{/* Absent on entries written before timestamps existed; backfilled on the next edit. */}
				{(entry.createdAt !== undefined || entry.updatedAt !== undefined) && (
					<div className="px-4 py-2.5 border-t border-border/50 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
						{entry.createdAt !== undefined && (
							<span>{t`Created ${formatDateTime(entry.createdAt)}`}</span>
						)}
						{entry.updatedAt !== undefined && (
							<span>{t`Updated ${formatDateTime(entry.updatedAt)}`}</span>
						)}
						{entry.archivedAt !== undefined && (
							<span>{t`Archived ${formatDateTime(entry.archivedAt)}`}</span>
						)}
					</div>
				)}

				{/* Kept away from Edit so a slip on the header can't archive or delete. */}
				<div className="px-4 py-2.5 border-t border-border/50 flex items-center justify-end gap-2">
					<Button
						variant="secondary"
						size="sm"
						onClick={handleSetArchived}
						disabled={archiving}
						aria-label={archived ? t`Restore entry` : t`Archive entry`}
						className="gap-1.5"
					>
						{archived ? (
							<ArchiveRestore className="w-3.5 h-3.5" />
						) : (
							<Archive className="w-3.5 h-3.5" />
						)}
						{archived ? <Trans>Restore</Trans> : <Trans>Archive</Trans>}
					</Button>
					<Button
						variant="destructiveOutline"
						size="sm"
						onClick={() => setConfirmDelete(true)}
						aria-label={t`Delete entry`}
						className="gap-1.5"
					>
						<Trash2 className="w-3.5 h-3.5" />
						<Trans>Delete</Trans>
					</Button>
				</div>

				{confirmDelete && (
					<div className="p-4 bg-muted/30 border-t border-border/50 flex items-center justify-between gap-3">
						<p className="flex-1 text-xs text-destructive">
							<Trans>Delete this entry permanently?</Trans>
						</p>
						<Button
							variant="secondary"
							size="none"
							onClick={() => setConfirmDelete(false)}
							disabled={deleting}
							className="px-4 py-2 text-sm hover:bg-background/50 hover:border-border"
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button variant="destructive" size="md" onClick={handleDelete} disabled={deleting}>
							{deleting ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
						</Button>
					</div>
				)}
			</div>
		</main>
	);
}
