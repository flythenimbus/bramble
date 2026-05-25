import { Eye, EyeOff, Plus, X } from "lucide-react";
import { useState } from "react";
import { useFieldArray, useFormContext } from "react-hook-form";
import type { CustomField } from "../../hooks/useVault";
import { SelectField } from "../components/ui/select-field";
import { TextField } from "../components/ui/text-field";
import { DetailField } from "./DetailField";

export interface CustomFieldFormValue {
	key: string;
	value: string;
	type: "text" | "password";
}

export const CUSTOM_FIELDS_NAME = "customFields";

export function customFieldsToForm(fields: CustomField[] | undefined): CustomFieldFormValue[] {
	return (fields ?? []).map((f) => ({
		key: f.key,
		value: f.value,
		type: f.hidden ? "password" : "text",
	}));
}

export function formToCustomFields(
	values: CustomFieldFormValue[] | undefined,
): CustomField[] | undefined {
	const out: CustomField[] = [];
	for (const f of values ?? []) {
		const key = f.key.trim();
		if (!key) continue;
		out.push({ key, value: f.value, ...(f.type === "password" ? { hidden: true } : {}) });
	}
	return out.length > 0 ? out : undefined;
}

export function customFieldsCopyItems(
	fields: CustomField[] | undefined,
): { label: string; value: string }[] {
	return (fields ?? []).filter((f) => f.value).map((f) => ({ label: f.key, value: f.value }));
}

export function customFieldsSearchText(fields: CustomField[] | undefined): string {
	return (fields ?? []).map((f) => `${f.key} ${f.value}`).join(" ");
}

export function CustomFieldsEditor() {
	const { register, control, watch } = useFormContext();
	const [shown, setShown] = useState<Record<string, boolean>>({});
	const { fields, append, remove } = useFieldArray({ control, name: CUSTOM_FIELDS_NAME });

	return (
		<div>
			<div className="flex items-center justify-between mb-2">
				<span className="block text-sm">Custom fields</span>
				<button
					type="button"
					onClick={() => append({ key: "", value: "", type: "text" })}
					className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all"
				>
					<Plus className="w-3 h-3" />
					Add field
				</button>
			</div>

			{fields.length > 0 ? (
				<div className="divide-y divide-border/50">
					{fields.map((field, index) => {
						const type = watch(`${CUSTOM_FIELDS_NAME}.${index}.type`);
						const isShown = shown[field.id] ?? false;
						return (
							<div key={field.id} className="py-4 first:pt-0 last:pb-0 space-y-3">
								<div className="flex gap-2 items-start">
									<div className="flex-1">
										<TextField
											label="Field name"
											type="text"
											{...register(`${CUSTOM_FIELDS_NAME}.${index}.key`)}
										/>
									</div>
									<div className="w-32">
										<SelectField label="Type" {...register(`${CUSTOM_FIELDS_NAME}.${index}.type`)}>
											<option value="text">Visible</option>
											<option value="password">Hidden</option>
										</SelectField>
									</div>
									<button
										type="button"
										onClick={() => remove(index)}
										className="mt-2 p-2 rounded-lg border border-transparent hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 active:scale-[0.95] transition-all shrink-0"
										aria-label="Remove field"
									>
										<X className="w-4 h-4" />
									</button>
								</div>
								<TextField
									label="Value"
									type={type === "password" && !isShown ? "password" : "text"}
									endAdornment={
										type === "password" ? (
											<button
												type="button"
												onClick={() => setShown((s) => ({ ...s, [field.id]: !isShown }))}
												className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
												aria-label={isShown ? "Hide value" : "Show value"}
											>
												{isShown ? (
													<EyeOff className="w-3.5 h-3.5" />
												) : (
													<Eye className="w-3.5 h-3.5" />
												)}
											</button>
										) : undefined
									}
									{...register(`${CUSTOM_FIELDS_NAME}.${index}.value`)}
								/>
							</div>
						);
					})}
				</div>
			) : (
				<p className="text-xs text-muted-foreground">
					Add custom fields to store additional information like security questions, billing postal
					codes, account numbers, etc.
				</p>
			)}
		</div>
	);
}

interface CustomFieldsDetailProps {
	fields: CustomField[];
	copied: string | null;
	copy: (label: string, value: string) => void;
}

export function CustomFieldsDetail({ fields, copied, copy }: CustomFieldsDetailProps) {
	const [shown, setShown] = useState<Record<number, boolean>>({});
	return (
		<>
			{fields.map((field, index) => {
				const isShown = shown[index] ?? false;
				const masked = field.hidden && !isShown;
				return (
					<DetailField
						// biome-ignore lint/suspicious/noArrayIndexKey: read-only static list, no stable id
						key={`${field.key}-${index}`}
						label={field.key}
						copied={copied}
						copyName={field.key}
						onCopy={() => copy(field.key, field.value)}
						extraAction={
							field.hidden ? (
								<button
									type="button"
									onClick={() => setShown((s) => ({ ...s, [index]: !isShown }))}
									className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
									aria-label={isShown ? "Hide value" : "Show value"}
								>
									{isShown ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
								</button>
							) : undefined
						}
					>
						<span className={`text-sm truncate ${field.hidden ? "font-mono" : ""}`}>
							{masked ? "•".repeat(Math.min(field.value.length, 16)) : field.value || "—"}
						</span>
					</DetailField>
				);
			})}
		</>
	);
}
