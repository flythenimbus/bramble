import { ArrowLeft, Eye, EyeOff, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";

interface CreatePasswordProps {
	onBack: () => void;
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

export function CreatePassword({ onBack }: CreatePasswordProps) {
	const [showPassword, setShowPassword] = useState(false);
	const [shownCustomFields, setShownCustomFields] = useState<Record<string, boolean>>({});

	const { register, handleSubmit, control, watch, setValue } = useForm<FormValues>({
		defaultValues: {
			name: "",
			url: "",
			username: "",
			password: "",
			notes: "",
			customFields: [],
		},
	});

	const { fields, append, remove } = useFieldArray({ control, name: "customFields" });

	const passwordValue = watch("password");
	const passwordStrength = useMemo(() => computeStrength(passwordValue), [passwordValue]);

	const generatePassword = () => {
		setValue("password", randomPassword(), { shouldDirty: true, shouldValidate: true });
	};

	const onSubmit = (data: FormValues) => {
		// TODO: encrypt + persist via useVault.addEntry once the data layer is wired.
		console.log("save entry", data);
		onBack();
	};

	const getStrengthColor = () => {
		if (passwordStrength === 0) return "bg-muted";
		if (passwordStrength <= 2) return "bg-destructive";
		if (passwordStrength === 3) return "bg-yellow-500";
		return "bg-primary";
	};

	const getStrengthText = () => {
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
						<div>
							<label className="block text-sm mb-2">Name</label>
							<input
								type="text"
								placeholder="e.g., Gmail, GitHub, Netflix"
								className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
								{...register("name")}
							/>
						</div>

						<div>
							<label className="block text-sm mb-2">Website URL</label>
							<input
								type="url"
								placeholder="https://example.com"
								className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
								{...register("url")}
							/>
						</div>

						<div>
							<label className="block text-sm mb-2">Username or Email</label>
							<input
								type="text"
								placeholder="username@example.com"
								className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
								{...register("username")}
							/>
						</div>

						<div>
							<label className="block text-sm mb-2">Password</label>
							<div className="relative">
								<input
									type={showPassword ? "text" : "password"}
									placeholder="Enter a strong password"
									className="w-full px-3 py-2 pr-24 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
									{...register("password")}
								/>
								<div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
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
								</div>
							</div>

							{passwordValue && (
								<div className="mt-2.5">
									<div className="flex items-center justify-between mb-1.5">
										<span className="text-xs text-muted-foreground">Password strength</span>
										<span
											className={`text-xs ${
												passwordStrength >= 3
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
											style={{ width: `${(passwordStrength / 4) * 100}%` }}
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
								Generate Strong Password
							</button>
						</div>

						<div>
							<label className="block text-sm mb-2">Notes (Optional)</label>
							<textarea
								placeholder="Add any additional information..."
								rows={4}
								className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all resize-none"
								{...register("notes")}
							/>
						</div>

						<div>
							<div className="flex items-center justify-between mb-2">
								<label className="block text-sm">Custom Fields</label>
								<button
									type="button"
									onClick={() => append({ key: "", value: "", type: "text" })}
									className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all"
								>
									<Plus className="w-3 h-3" />
									Add Field
								</button>
							</div>

							{fields.length > 0 ? (
								<div className="space-y-3">
									{fields.map((field, index) => {
										const type = watch(`customFields.${index}.type`);
										const shown = shownCustomFields[field.id] ?? false;
										return (
											<div
												key={field.id}
												className="p-3 rounded-lg border border-border/50 bg-background/30"
											>
												<div className="flex gap-2 items-start mb-2">
													<input
														type="text"
														placeholder="Field name"
														className="flex-1 px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
														{...register(`customFields.${index}.key`)}
													/>
													<select
														className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
														{...register(`customFields.${index}.type`)}
													>
														<option value="text">Visible</option>
														<option value="password">Hidden</option>
													</select>
													<button
														type="button"
														onClick={() => remove(index)}
														className="p-2 rounded-lg border border-transparent hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 active:scale-[0.95] transition-all"
														aria-label="Remove field"
													>
														<X className="w-4 h-4" />
													</button>
												</div>
												<div className="relative">
													<input
														type={type === "password" && !shown ? "password" : "text"}
														placeholder="Value"
														className="w-full px-3 py-2 pr-10 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
														{...register(`customFields.${index}.value`)}
													/>
													{type === "password" && (
														<button
															type="button"
															onClick={() =>
																setShownCustomFields((s) => ({ ...s, [field.id]: !shown }))
															}
															className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
															aria-label={shown ? "Hide value" : "Show value"}
														>
															{shown ? (
																<EyeOff className="w-3.5 h-3.5" />
															) : (
																<Eye className="w-3.5 h-3.5" />
															)}
														</button>
													)}
												</div>
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
					</div>

					<div className="px-6 py-4 bg-muted/30 border-t border-border/50 flex items-center justify-between">
						<button
							type="button"
							onClick={onBack}
							className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-background/50 active:scale-[0.98] transition-all"
						>
							Cancel
						</button>
						<button
							type="submit"
							className="px-5 py-2 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all"
						>
							Save Password
						</button>
					</div>
				</div>

				<div className="mt-4 p-4 rounded-lg border border-border/50 bg-card/30 backdrop-blur-sm">
					<h4 className="text-sm mb-2 flex items-center gap-2">
						<Sparkles className="w-4 h-4 text-primary" />
						Tips for strong passwords
					</h4>
					<ul className="text-xs text-muted-foreground space-y-1">
						<li>• Use at least 12 characters</li>
						<li>• Mix uppercase and lowercase letters</li>
						<li>• Include numbers and special characters</li>
						<li>• Avoid common words and personal information</li>
					</ul>
				</div>
			</form>
		</main>
	);
}
