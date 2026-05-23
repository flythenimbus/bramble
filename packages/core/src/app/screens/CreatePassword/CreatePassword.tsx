import {
	ArrowLeft,
	ChevronDown,
	ChevronRight,
	Eye,
	EyeOff,
	Globe,
	Plus,
	RefreshCw,
	Sparkles,
	X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import type { SubdomainMatchMode } from "../../../adapters/autofill";
import type { BreachStatus } from "../../../hooks/useVault";
import { SelectField } from "../../components/ui/select-field";
import { TextArea } from "../../components/ui/text-area";
import { TextField } from "../../components/ui/text-field";

export interface EntryDraft {
	name: string;
	url: string;
	username: string;
	password: string;
	notes?: string;
	// Per-entry autofill behavior. Omitted = use defaults.
	autofillEnabled?: boolean;
	autoSubmit?: boolean;
	subdomainMatch?: SubdomainMatchMode;
}

interface CreatePasswordProps {
	defaultUrl?: string;
	initialValues?: EntryDraft;
	// Breach status cached for `initialValues.password`. While the field
	// hasn't been edited we trust this value so we can flag a known-breached
	// password without re-querying HIBP on every render.
	initialBreach?: BreachStatus;
	submitLabel?: string;
	onBack: () => void;
	onSave: (data: EntryDraft) => Promise<void>;
}

interface CustomFieldValue {
	key: string;
	value: string;
	type: "text" | "password";
}

interface FormValues {
	name: string;
	url: string;
	username: string;
	password: string;
	notes: string;
	customFields: CustomFieldValue[];
	autofillEnabled: boolean;
	autoSubmit: boolean;
	subdomainMatch: SubdomainMatchMode;
}

function computeStrength(value: string): number {
	let s = 0;
	if (value.length >= 8) s++;
	if (value.length >= 12) s++;
	if (/[a-z]/.test(value) && /[A-Z]/.test(value)) s++;
	if (/\d/.test(value)) s++;
	if (/[^a-zA-Z0-9]/.test(value)) s++;
	return Math.min(s, 4);
}

function randomPassword(): string {
	const charset =
		"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?";
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => charset.charAt(b % charset.length)).join("");
}

export function CreatePassword({
	defaultUrl = "",
	initialValues,
	initialBreach,
	submitLabel = "Save password",
	onBack,
	onSave,
}: CreatePasswordProps) {
	const [showPassword, setShowPassword] = useState(false);
	const [shownCustomFields, setShownCustomFields] = useState<Record<string, boolean>>({});
	const [busy, setBusy] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const startUrl = initialValues?.url ?? defaultUrl;
	const [hasWebsite, setHasWebsite] = useState(startUrl !== "");
	const [advancedOpen, setAdvancedOpen] = useState(false);

	const { register, handleSubmit, control, watch, setValue } = useForm<FormValues>({
		defaultValues: {
			name: initialValues?.name ?? "",
			url: startUrl,
			username: initialValues?.username ?? "",
			password: initialValues?.password ?? "",
			notes: initialValues?.notes ?? "",
			customFields: [],
			autofillEnabled: initialValues?.autofillEnabled !== false,
			autoSubmit: initialValues?.autoSubmit === true,
			subdomainMatch: initialValues?.subdomainMatch ?? "etld1",
		},
	});

	const { fields, append, remove } = useFieldArray({ control, name: "customFields" });

	const passwordValue = watch("password");
	const passwordStrength = useMemo(() => computeStrength(passwordValue), [passwordValue]);
	// Only trust the cached breach result while the user hasn't edited the
	// password — once it changes, the cached flag refers to a different string.
	const isBreached = initialBreach?.leaked === true && passwordValue === initialValues?.password;

	const generatePassword = () => {
		setValue("password", randomPassword(), { shouldDirty: true, shouldValidate: true });
	};

	const onSubmit = async (data: FormValues) => {
		setSaveError(null);
		setBusy(true);
		try {
			// customFields aren't persisted yet — wire them once the data model supports them.
			await onSave({
				name: data.name,
				url: data.url,
				username: data.username,
				password: data.password,
				notes: data.notes || undefined,
				// Only persist overrides when they differ from defaults, so old
				// entries stay byte-clean and the encrypted payload is minimal.
				autofillEnabled: data.autofillEnabled ? undefined : false,
				autoSubmit: data.autoSubmit ? true : undefined,
				subdomainMatch: data.subdomainMatch === "etld1" ? undefined : data.subdomainMatch,
			});
			onBack();
		} catch (e) {
			setSaveError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	const getStrengthColor = () => {
		if (isBreached) return "bg-destructive";
		if (passwordStrength === 0) return "bg-muted";
		if (passwordStrength <= 2) return "bg-destructive";
		if (passwordStrength === 3) return "bg-yellow-500";
		return "bg-primary";
	};

	const getStrengthText = () => {
		if (isBreached) return "Breached";
		if (passwordStrength === 0) return "No password";
		if (passwordStrength <= 2) return "Weak";
		if (passwordStrength === 3) return "Good";
		return "Strong";
	};

	return (
		<main className="max-w-5xl mx-auto px-4 py-5">
			<button
				onClick={onBack}
				type="button"
				className="flex items-center gap-2 mb-4 text-sm text-muted-foreground hover:text-foreground active:scale-[0.98] transition-all"
			>
				<ArrowLeft className="w-4 h-4" />
				Back to passwords
			</button>

			<form onSubmit={handleSubmit(onSubmit)}>
				<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
					<div className="p-6 space-y-5">
						<TextField label="Name" type="text" {...register("name")} />

						{hasWebsite ? (
							<div className="space-y-1">
								<TextField
									label="Website URL"
									type="url"
									endAdornment={
										<button
											type="button"
											onClick={() => {
												setHasWebsite(false);
												setValue("url", "");
											}}
											className="p-1.5 rounded-md border border-transparent hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 active:scale-[0.95] transition-all"
											aria-label="Remove website URL"
										>
											<X className="w-3.5 h-3.5" />
										</button>
									}
									{...register("url")}
								/>
							</div>
						) : (
							<button
								type="button"
								onClick={() => setHasWebsite(true)}
								className="flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg border border-border/50 text-muted-foreground hover:bg-primary/5 hover:border-primary/50 hover:text-foreground active:scale-[0.98] transition-all"
							>
								<Globe className="w-3.5 h-3.5" />
								Add website URL
							</button>
						)}

						<TextField label="Username or email" type="text" {...register("username")} />

						<div>
							<TextField
								label="Password"
								type={showPassword ? "text" : "password"}
								endAdornment={
									<>
										<button
											type="button"
											onClick={generatePassword}
											className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
											aria-label="Generate password"
										>
											<RefreshCw className="w-3.5 h-3.5" />
										</button>
										<button
											type="button"
											onClick={() => setShowPassword(!showPassword)}
											className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
											aria-label={showPassword ? "Hide password" : "Show password"}
										>
											{showPassword ? (
												<EyeOff className="w-3.5 h-3.5" />
											) : (
												<Eye className="w-3.5 h-3.5" />
											)}
										</button>
									</>
								}
								{...register("password")}
							/>

							{passwordValue && (
								<div className="mt-2.5">
									<div className="flex items-center justify-between mb-1.5">
										<span className="text-xs text-muted-foreground">Password strength</span>
										<span
											className={`text-xs ${
												isBreached
													? "text-destructive"
													: passwordStrength >= 3
														? "text-primary"
														: passwordStrength === 0
															? "text-muted-foreground"
															: "text-destructive"
											}`}
										>
											{getStrengthText()}
										</span>
									</div>
									<div className="h-1.5 bg-muted rounded-full overflow-hidden">
										<div
											className={`h-full transition-all duration-300 ${getStrengthColor()}`}
											style={{
												width: isBreached ? "5%" : `${(passwordStrength / 4) * 100}%`,
											}}
										/>
									</div>
								</div>
							)}

							<button
								type="button"
								onClick={generatePassword}
								className="mt-3 flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg border border-primary/50 bg-primary/5 text-primary hover:bg-primary/10 active:scale-[0.98] transition-all"
							>
								<Sparkles className="w-3.5 h-3.5" />
								Generate strong password
							</button>
						</div>

						<TextArea label="Notes (optional)" rows={4} {...register("notes")} />

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
										const type = watch(`customFields.${index}.type`);
										const shown = shownCustomFields[field.id] ?? false;
										return (
											<div key={field.id} className="py-4 first:pt-0 last:pb-0 space-y-3">
												<div className="flex gap-2 items-start">
													<div className="flex-1">
														<TextField
															label="Field name"
															type="text"
															{...register(`customFields.${index}.key`)}
														/>
													</div>
													<div className="w-32">
														<SelectField label="Type" {...register(`customFields.${index}.type`)}>
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
													type={type === "password" && !shown ? "password" : "text"}
													endAdornment={
														type === "password" ? (
															<button
																type="button"
																onClick={() =>
																	setShownCustomFields((s) => ({ ...s, [field.id]: !shown }))
																}
																className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
																aria-label={shown ? "Hide value" : "Show value"}
															>
																{shown ? (
																	<EyeOff className="w-3.5 h-3.5" />
																) : (
																	<Eye className="w-3.5 h-3.5" />
																)}
															</button>
														) : undefined
													}
													{...register(`customFields.${index}.value`)}
												/>
											</div>
										);
									})}
								</div>
							) : (
								<p className="text-xs text-muted-foreground">
									Add custom fields to store additional information like security questions, account
									numbers, etc.
								</p>
							)}
						</div>

						<div>
							<button
								type="button"
								onClick={() => setAdvancedOpen((o) => !o)}
								className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground active:scale-[0.98] transition-all"
								aria-expanded={advancedOpen}
							>
								{advancedOpen ? (
									<ChevronDown className="w-3.5 h-3.5" />
								) : (
									<ChevronRight className="w-3.5 h-3.5" />
								)}
								Advanced
							</button>
							{advancedOpen && (
								<div className="mt-3 space-y-4 pl-4 border-l border-border/40">
									<ToggleRow
										title="Enable autofill"
										subtitle="Show this entry in the autofill dropdown. When off, it's never auto-filled but stays in your vault."
										checked={watch("autofillEnabled")}
										onChange={(v) =>
											setValue("autofillEnabled", v, {
												shouldDirty: true,
											})
										}
									/>
									<ToggleRow
										title="Auto-submit after fill"
										subtitle="Press Enter / submit the form right after the credentials are filled in."
										checked={watch("autoSubmit")}
										onChange={(v) => setValue("autoSubmit", v, { shouldDirty: true })}
									/>
									<div>
										<SelectField label="Subdomain match" {...register("subdomainMatch")}>
											<option value="etld1">eTLD+1 (default — matches all subdomains)</option>
											<option value="exact">Exact hostname only</option>
											<option value="subdomain">This domain and its subdomains</option>
										</SelectField>
										<p className="text-xs text-muted-foreground mt-1.5">
											Controls which URLs this entry will offer credentials for.
										</p>
									</div>
								</div>
							)}
						</div>
					</div>

					<div className="px-6 py-4 bg-muted/30 border-t border-border/50 flex items-center justify-between gap-3">
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
							{busy ? "Saving…" : submitLabel}
						</button>
					</div>
				</div>
			</form>
		</main>
	);
}

interface ToggleRowProps {
	title: string;
	subtitle: string;
	checked: boolean;
	onChange: (next: boolean) => void;
}

function ToggleRow({ title, subtitle, checked, onChange }: ToggleRowProps) {
	return (
		<div className="flex items-start justify-between gap-3">
			<div className="min-w-0">
				<p className="text-sm">{title}</p>
				<p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
			</div>
			<button
				type="button"
				onClick={() => onChange(!checked)}
				aria-pressed={checked}
				className={`relative shrink-0 w-11 h-6 rounded-full border transition-all ${
					checked ? "bg-primary border-primary/20" : "bg-muted border-border"
				}`}
			>
				<span
					className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all ${
						checked ? "left-5" : "left-0.5"
					}`}
				/>
			</button>
		</div>
	);
}
