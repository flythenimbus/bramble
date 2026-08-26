import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Tag, TagsIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useVault } from "../../hooks/useVault";
import { allTags, normalizeTags, tagKey } from "../../vault/tags";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { TextField } from "../components/ui/text-field";
import type { BulkAction, BulkActionDialogProps } from "./types";

/**
 * Add and remove are the same transition in two directions, so they share a dialog
 * parameterized by which way it runs. Both are registered; each greys itself out for a
 * selection it cannot change.
 */
function dialogFor(adding: boolean) {
	return function TagDialog({ open, onClose, onDone, ids, entries }: BulkActionDialogProps) {
		const { entries: allEntries, setEntriesTags } = useVault();
		const { t } = useLingui();
		const [draft, setDraft] = useState("");

		const tag = normalizeTags([draft])?.[0];
		// Adding offers the whole vocabulary; removing offers only what the selection
		// actually carries, so the list can't propose a no-op.
		const suggestions = useMemo(
			() => (adding ? allTags(allEntries) : allTags(entries)),
			[allEntries, entries],
		);
		// The count in the button has to be what will really change, or "Add to 12" runs
		// on a selection where 9 already had the tag.
		const affected = tag
			? entries.filter((e) => (e.tags ?? []).some((x) => tagKey(x) === tagKey(tag)) !== adding)
					.length
			: 0;

		return (
			<ConfirmDialog
				open={open}
				onClose={onClose}
				title={adding ? <Trans>Add a tag</Trans> : <Trans>Remove a tag</Trans>}
				confirmLabel={
					adding ? (
						<Plural value={affected} one="Tag # entry" other="Tag # entries" />
					) : (
						<Plural value={affected} one="Untag # entry" other="Untag # entries" />
					)
				}
				busyLabel={adding ? <Trans>Tagging…</Trans> : <Trans>Removing…</Trans>}
				onConfirm={async () => {
					if (!tag) return;
					await setEntriesTags(ids, adding ? { add: [tag] } : { remove: [tag] });
					onDone();
				}}
			>
				<TextField
					label={adding ? t`Tag` : t`Tag to remove`}
					type="text"
					autoComplete="off"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
				/>

				{suggestions.length > 0 && (
					<div className="flex flex-wrap gap-1.5">
						{suggestions
							.filter((s) => tagKey(s).startsWith(tagKey(draft)))
							.slice(0, 8)
							.map((s) => (
								<Button
									key={tagKey(s)}
									variant="link"
									size="none"
									onClick={() => setDraft(s)}
									className="inline-flex items-center gap-1 rounded-full border border-border/50 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-border"
								>
									<Tag className="w-3 h-3 shrink-0" />
									{s}
								</Button>
							))}
					</div>
				)}

				{tag && affected === 0 && (
					<p className="text-sm text-muted-foreground">
						{adding ? (
							<Trans>Every selected entry already has this tag.</Trans>
						) : (
							<Trans>None of the selected entries have this tag.</Trans>
						)}
					</p>
				)}
			</ConfirmDialog>
		);
	};
}

export const addTagAction: BulkAction = {
	id: "add-tag",
	get label() {
		return i18n._(msg`Add tag`);
	},
	icon: TagsIcon,
	Dialog: dialogFor(true),
};

export const removeTagAction: BulkAction = {
	id: "remove-tag",
	get label() {
		return i18n._(msg`Remove tag`);
	},
	icon: Tag,
	// Nothing to take off a selection that carries no tags at all.
	isEnabled: (entries) => entries.some((e) => (e.tags?.length ?? 0) > 0),
	Dialog: dialogFor(false),
};
