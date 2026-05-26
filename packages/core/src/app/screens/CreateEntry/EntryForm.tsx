import { useEffect, useState } from "react";
import { type FieldValues, FormProvider, useForm } from "react-hook-form";
import type { BreachStatus, EntryData, EntryType } from "../../../hooks/useVault";
import { getEntryMode } from "../../entry-modes";
import {
	CUSTOM_FIELDS_NAME,
	CustomFieldsEditor,
	customFieldsToForm,
	formToCustomFields,
} from "../../entry-modes/custom-fields";

export type EntryFormDraft = FieldValues;

interface EntryFormProps {
	type: EntryType;
	defaultUrl?: string;
	initialEntry?: EntryData;
	initialBreach?: BreachStatus;
	draftValues?: EntryFormDraft;
	registerDraft?: (getter: (() => EntryFormDraft) | null) => void;
	submitLabel?: string;
	onBack: () => void;
	onSave: (data: EntryData) => Promise<void>;
}

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
	const mode = getEntryMode(type);
	const [busy, setBusy] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	const methods = useForm<FieldValues>({
		// A restored draft wins (it already carries custom fields); otherwise seed
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
	const heading = `${initialEntry ? "Edit" : "New"} ${mode.label}`;
	const label = submitLabel ?? `Save ${mode.label}`;

	return (
		<main className="max-w-5xl mx-auto px-4 py-3">
			<FormProvider {...methods}>
				    peer password managers) that this is an entry editor, not a real
				    login form, so they don't try to save / autofill the values the
				    user is *storing*. Chrome ignores autoComplete="off" on bare login
				    forms, hence the form-type hint. */}
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
							<button
								type="button"
								onClick={onBack}
								disabled={busy}
								className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-background/50 active:scale-[0.98] transition-all disabled:opacity-50"
							>
								Cancel
							</button>
							{saveError && (
								<p className="flex-1 text-xs text-destructive truncate" title={saveError}>
									{saveError}
								</p>
							)}
							<button
								type="submit"
								disabled={busy}
								className="px-5 py-2 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{busy ? "Saving…" : label}
							</button>
						</div>
					</div>
				</form>
			</FormProvider>
		</main>
	);
}
