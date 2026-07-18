import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { type FieldValues, FormProvider, useForm } from "react-hook-form";
import type { BreachStatus, EntryData, EntryType } from "../../../hooks/useVault";
import { Button } from "../../components/ui/button";
import { getEntryMode } from "../../entry-modes";
import {
	CUSTOM_FIELDS_NAME,
	CustomFieldsEditor,
	customFieldsToForm,
	formToCustomFields,
} from "../../entry-modes/custom-fields";

/**
 * Serializable snapshot of the live form, carried verbatim through a pop-out
 * handoff. Loosely typed: its shape depends on the active mode.
 */
export type EntryFormDraft = FieldValues;

interface EntryFormProps {
	// Keep stable for the host's lifetime: callers key the host by type, so a
	// type change remounts it.
	type: EntryType;
	defaultUrl?: string;
	initialEntry?: EntryData;
	initialBreach?: BreachStatus;
	// Restored pop-out snapshot; wins over initialEntry / defaultUrl when present.
	draftValues?: EntryFormDraft;
	registerDraft?: (getter: (() => EntryFormDraft) | null) => void;
	submitLabel?: string;
	onBack: () => void;
	onSave: (data: EntryData) => Promise<void>;
}

/** Shared create/edit form chrome for any entry mode; inputs and form-entry mapping come from the mode descriptor. */
export function EntryForm({
	type,
	defaultUrl = "",
	initialEntry,
	initialBreach,
	draftValues,
	registerDraft,
	submitLabel,
	onBack,
	onSave,
}: EntryFormProps) {
	const { t } = useLingui();
	const mode = getEntryMode(type);
	const [busy, setBusy] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	const methods = useForm<FieldValues>({
		// A restored draft wins (it already carries custom fields); otherwise seed
		// from the stored entry (edit) or a blank form (create), plus shared custom fields.
		defaultValues: draftValues ?? {
			...(initialEntry ? mode.toForm(initialEntry) : mode.emptyForm({ defaultUrl })),
			[CUSTOM_FIELDS_NAME]: customFieldsToForm(initialEntry?.customFields),
		},
	});
	const { handleSubmit, getValues } = methods;

	useEffect(() => {
		if (!registerDraft) return;
		registerDraft(() => getValues());
		return () => registerDraft(null);
	}, [registerDraft, getValues]);

	const onSubmit = async (values: FieldValues) => {
		setSaveError(null);
		setBusy(true);
		try {
			await onSave({
				...mode.toEntry(values),
				customFields: formToCustomFields(values[CUSTOM_FIELDS_NAME]),
			});
			onBack();
		} catch (e) {
			setSaveError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	const Fields = mode.Fields;
	// Label verbatim so acronyms keep their case (e.g. "SSH key").
	const modeLabel = mode.label;
	const heading = initialEntry ? <Trans>Edit {modeLabel}</Trans> : <Trans>New {modeLabel}</Trans>;
	const label = submitLabel ?? t`Save ${modeLabel}`;

	return (
		<main className="max-w-5xl mx-auto px-4 py-3">
			<FormProvider {...methods}>
				{/* data-form-type="other" marks this as an entry editor, not a login form, so
				    browsers/peer managers don't save/autofill. Chrome ignores autoComplete="off"
				    on bare login forms, hence the hint. */}
				<form onSubmit={handleSubmit(onSubmit)} autoComplete="off" data-form-type="other">
					<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
						<div className="px-5 py-2.5 border-b border-border/50">
							<h2 className="text-xs text-muted-foreground">{heading}</h2>
						</div>

						<div className="px-5 py-4 space-y-3">
							<Fields initialBreach={initialBreach} />
							<CustomFieldsEditor />
						</div>

						<div className="px-5 py-3 bg-muted/30 border-t border-border/50 flex items-center justify-between gap-3">
							<Button
								variant="secondary"
								size="none"
								onClick={onBack}
								disabled={busy}
								className="px-4 py-2 text-sm hover:bg-background/50 hover:border-border"
							>
								<Trans>Cancel</Trans>
							</Button>
							{saveError && (
								<p className="flex-1 text-xs text-destructive truncate" title={saveError}>
									{saveError}
								</p>
							)}
							<Button type="submit" variant="primary" size="md" disabled={busy}>
								{busy ? t`Saving…` : label}
							</Button>
						</div>
					</div>
				</form>
			</FormProvider>
		</main>
	);
}
