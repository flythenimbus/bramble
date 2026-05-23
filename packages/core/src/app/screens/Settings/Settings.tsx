import {
	AlertTriangle,
	ArrowLeft,
	Clock,
	Download,
	Info,
	Key,
	Lock,
	Palette,
	Shield,
	ShieldCheck,
	Timer,
	Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { SelectField } from "../../components/ui/select-field";
import { TextField } from "../../components/ui/text-field";

interface PasswordFormValues {
	currentPassword: string;
	newPassword: string;
	confirmPassword: string;
}

interface SettingsProps {
	onBack: () => void;
	darkMode: boolean;
	onToggleTheme: () => void;
	autoLockMinutes: number;
	clipboardClearSeconds: number;
	breachCheckEnabled: boolean;
	totalEntries: number;
	onChangeAutoLock: (minutes: number) => void;
	onChangeClipboardSeconds: (seconds: number) => void;
	onToggleBreachCheck: (enabled: boolean) => void;
	onLockNow: () => Promise<void>;
	// Two-step contract so the UI can distinguish a wrong current password
	// (field-level error, recoverable) from a rotation failure (form-level
	// error, the user may need to retry or relock).
	onVerifyCurrentPassword: (currentPassword: string) => Promise<boolean>;
	onChangeMasterPassword: (newPassword: string) => Promise<void>;
}

export function Settings({
	onBack,
	darkMode,
	onToggleTheme,
	autoLockMinutes,
	clipboardClearSeconds,
	breachCheckEnabled,
	totalEntries,
	onChangeAutoLock,
	onChangeClipboardSeconds,
	onToggleBreachCheck,
	onLockNow,
	onVerifyCurrentPassword,
	onChangeMasterPassword,
}: SettingsProps) {
	const [changingPassword, setChangingPassword] = useState(false);
	const [pwSuccess, setPwSuccess] = useState(false);
	// Form-level error (rotation crash, disk write failure, etc.) lives
	// outside react-hook-form because it isn't tied to any single field.
	const [formError, setFormError] = useState<string | null>(null);
	const formErrorRef = useRef<HTMLDivElement>(null);

	const {
		register,
		handleSubmit,
		reset,
		setError,
		watch,
		formState: { errors, isSubmitting },
	} = useForm<PasswordFormValues>({
		defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
	});

	// `watch` is used by the confirm-password validator below.
	const newPasswordValue = watch("newPassword");

	// In a popup window the user is often scrolled down to the submit
	// button when they press Enter; the error banner appearing above the
	// form would be off-screen without this nudge.
	useEffect(() => {
		if (formError) {
			formErrorRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
		}
	}, [formError]);

	const closePasswordForm = () => {
		setChangingPassword(false);
		setFormError(null);
		reset();
	};

	const onSubmitPasswordChange = async ({ currentPassword, newPassword }: PasswordFormValues) => {
		setFormError(null);
		setPwSuccess(false);
		try {
			const ok = await onVerifyCurrentPassword(currentPassword);
			if (!ok) {
				setError(
					"currentPassword",
					{ message: "Current password is incorrect" },
					{ shouldFocus: true },
				);
				return;
			}
			await onChangeMasterPassword(newPassword);
			reset();
			setPwSuccess(true);
			setChangingPassword(false);
		} catch (e) {
			setFormError((e as Error).message);
		}
	};

	return (
		<main className="max-w-5xl mx-auto px-4 py-5">
			{/* Back button */}
			<button
				onClick={onBack}
				className="flex items-center gap-2 mb-4 text-sm text-muted-foreground hover:text-foreground active:scale-[0.98] transition-all"
			>
				<ArrowLeft className="w-4 h-4" />
				Back to vault
			</button>

			<div className="space-y-4">
				{/* Security Settings */}
				<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
					<div className="px-4 py-3 border-b border-border/50">
						<h3 className="text-sm flex items-center gap-2">
							<Lock className="w-4 h-4 text-primary" />
							Security
						</h3>
					</div>
					<div className="p-4 space-y-4">
						{/* Auto-lock timeout */}
						<Row
							icon={<Clock className="w-4 h-4 text-primary" />}
							title="Auto-lock timeout"
							subtitle="Lock vault after inactivity"
						>
							<div className="w-44">
								<SelectField
									label="Timeout"
									value={String(autoLockMinutes)}
									onChange={(e) => onChangeAutoLock(Number(e.target.value))}
								>
									<option value="5">5 minutes</option>
									<option value="15">15 minutes</option>
									<option value="30">30 minutes</option>
									<option value="60">1 hour</option>
									<option value="0">Never</option>
								</SelectField>
							</div>
						</Row>

						{/* Clipboard auto-clear */}
						<Row
							icon={<Timer className="w-4 h-4 text-primary" />}
							title="Clipboard auto-clear"
							subtitle="Wipe copied passwords after"
						>
							<div className="w-44">
								<SelectField
									label="Clear after"
									value={String(clipboardClearSeconds)}
									onChange={(e) => onChangeClipboardSeconds(Number(e.target.value))}
								>
									<option value="15">15 seconds</option>
									<option value="30">30 seconds</option>
									<option value="60">1 minute</option>
									<option value="120">2 minutes</option>
								</SelectField>
							</div>
						</Row>

						{/* Breach check */}
						<Row
							icon={<ShieldCheck className="w-4 h-4 text-primary" />}
							title="Check passwords for breaches"
							subtitle="Use HIBP (k-anonymity, your password is never sent)"
						>
							<Toggle
								checked={breachCheckEnabled}
								onChange={onToggleBreachCheck}
								label="Toggle breach checks"
							/>
						</Row>

						{/* Lock now */}
						<Row
							icon={<Lock className="w-4 h-4 text-primary" />}
							title="Lock vault"
							subtitle="Immediately lock and require master password to re-open"
						>
							<button
								type="button"
								onClick={() => void onLockNow()}
								className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all"
							>
								Lock now
							</button>
						</Row>

						{/* Change Master Password */}
						<Row
							icon={<Key className="w-4 h-4 text-primary" />}
							title="Change master password"
							subtitle="Rotates the vault key and re-encrypts every entry"
						>
							{!changingPassword ? (
								<button
									type="button"
									onClick={() => {
										reset();
										setFormError(null);
										setPwSuccess(false);
										setChangingPassword(true);
									}}
									className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all"
								>
									Change
								</button>
							) : null}
						</Row>

						{pwSuccess && !changingPassword && (
							<p className="text-xs text-primary pl-12">Master password updated.</p>
						)}

						{changingPassword && (
							<form
								className="ml-12 space-y-3 pt-1"
								onSubmit={handleSubmit(onSubmitPasswordChange)}
								noValidate
							>
								{formError && (
									<div
										ref={formErrorRef}
										role="alert"
										aria-live="assertive"
										className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/15 px-3 py-2.5 text-sm text-destructive"
									>
										<AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
										<span className="font-medium">{formError}</span>
									</div>
								)}
								<div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground/90">
									<Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" />
									<span>
										Rotates the vault encryption key and re-encrypts{" "}
										{totalEntries === 1 ? "your entry" : `all ${totalEntries} entries`} under fresh
										keys. Old keys and ciphertext are discarded — anyone who held the previous key
										can no longer decrypt this vault.
									</span>
								</div>
								<TextField
									label="Current password"
									type="password"
									autoComplete="current-password"
									autoFocus
									error={errors.currentPassword?.message}
									{...register("currentPassword", {
										required: "Enter your current password",
									})}
								/>
								<TextField
									label="New password"
									type="password"
									autoComplete="new-password"
									error={errors.newPassword?.message}
									{...register("newPassword", {
										required: "Enter a new password",
										minLength: {
											value: 8,
											message: "Must be at least 8 characters",
										},
									})}
								/>
								<TextField
									label="Confirm new password"
									type="password"
									autoComplete="new-password"
									error={errors.confirmPassword?.message}
									{...register("confirmPassword", {
										required: "Confirm your new password",
										validate: (value) => value === newPasswordValue || "Passwords don't match",
									})}
								/>
								<div className="flex items-center justify-end gap-2">
									<button
										type="button"
										onClick={closePasswordForm}
										disabled={isSubmitting}
										className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-background/50 active:scale-[0.98] transition-all disabled:opacity-50"
									>
										Cancel
									</button>
									<button
										type="submit"
										disabled={isSubmitting}
										className="px-3 py-1.5 text-xs rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50"
									>
										{isSubmitting ? "Updating…" : "Update password"}
									</button>
								</div>
							</form>
						)}
					</div>
				</div>

				{/* Appearance */}
				<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
					<div className="px-4 py-3 border-b border-border/50">
						<h3 className="text-sm flex items-center gap-2">
							<Palette className="w-4 h-4 text-primary" />
							Appearance
						</h3>
					</div>
					<div className="p-4">
						<Row
							icon={<Palette className="w-4 h-4 text-primary" />}
							title="Theme"
							subtitle="Choose light or dark mode"
						>
							<div className="flex items-center gap-2">
								<button
									onClick={onToggleTheme}
									className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${
										!darkMode
											? "bg-primary text-primary-foreground border-primary/20"
											: "border-border hover:bg-primary/5 hover:border-primary/50"
									}`}
								>
									Light
								</button>
								<button
									onClick={onToggleTheme}
									className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${
										darkMode
											? "bg-primary text-primary-foreground border-primary/20"
											: "border-border hover:bg-primary/5 hover:border-primary/50"
									}`}
								>
									Dark
								</button>
							</div>
						</Row>
					</div>
				</div>

				{/* Data Management */}
				<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
					<div className="px-4 py-3 border-b border-border/50">
						<h3 className="text-sm flex items-center gap-2">
							<Download className="w-4 h-4 text-primary" />
							Data Management
						</h3>
					</div>
					<div className="p-4 space-y-4">
						<Row
							icon={<Download className="w-4 h-4 text-primary" />}
							title="Export vault"
							subtitle="Download your passwords as JSON or CSV"
						>
							<button
								disabled
								className="px-3 py-1.5 text-xs rounded-lg border border-border opacity-50 cursor-not-allowed"
							>
								Export
							</button>
						</Row>
						<Row
							icon={<Upload className="w-4 h-4 text-primary" />}
							title="Import passwords"
							subtitle="Import from other password managers"
						>
							<button
								disabled
								className="px-3 py-1.5 text-xs rounded-lg border border-border opacity-50 cursor-not-allowed"
							>
								Import
							</button>
						</Row>
					</div>
				</div>

				{/* About */}
				<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
					<div className="px-4 py-3 border-b border-border/50">
						<h3 className="text-sm flex items-center gap-2">
							<Info className="w-4 h-4 text-primary" />
							About
						</h3>
					</div>
					<div className="p-4 space-y-3">
						<div className="flex items-center justify-between text-sm">
							<span className="text-muted-foreground">Version</span>
							<span>0.0.1</span>
						</div>
						<div className="flex items-center justify-between text-sm">
							<span className="text-muted-foreground">Total passwords</span>
							<span>{totalEntries}</span>
						</div>
					</div>
				</div>

				{/* Danger Zone (placeholder — destructive vault delete is out of scope for now) */}
				<div className="rounded-lg border border-destructive/50 bg-card/50 backdrop-blur-sm overflow-hidden">
					<div className="px-4 py-3 border-b border-destructive/50">
						<h3 className="text-sm flex items-center gap-2 text-destructive">
							<Shield className="w-4 h-4" />
							Danger Zone
						</h3>
					</div>
					<div className="p-4">
						<div className="flex items-center justify-between">
							<div>
								<p className="text-sm">Delete vault</p>
								<p className="text-xs text-muted-foreground mt-0.5">
									Permanently delete all your data (not implemented)
								</p>
							</div>
							<button
								disabled
								className="px-3 py-1.5 text-xs rounded-lg border border-destructive/50 text-destructive opacity-50 cursor-not-allowed"
							>
								Delete
							</button>
						</div>
					</div>
				</div>
			</div>
		</main>
	);
}

interface RowProps {
	icon: React.ReactNode;
	title: string;
	subtitle: string;
	children: React.ReactNode;
}

function Row({ icon, title, subtitle, children }: RowProps) {
	return (
		<div className="flex items-center justify-between gap-3">
			<div className="flex items-start gap-3 min-w-0">
				<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 flex-shrink-0">
					{icon}
				</div>
				<div className="min-w-0">
					<p className="text-sm">{title}</p>
					<p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
				</div>
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

interface ToggleProps {
	checked: boolean;
	onChange: (next: boolean) => void;
	label: string;
}

function Toggle({ checked, onChange, label }: ToggleProps) {
	return (
		<button
			type="button"
			onClick={() => onChange(!checked)}
			aria-label={label}
			aria-pressed={checked}
			className={`relative w-11 h-6 rounded-full border transition-all ${
				checked ? "bg-primary border-primary/20" : "bg-muted border-border"
			}`}
		>
			<span
				className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all ${
					checked ? "left-5" : "left-0.5"
				}`}
			/>
		</button>
	);
}
