import {
	AlertTriangle,
	Clock,
	Download,
	Info,
	Key,
	KeyRound,
	Lock,
	Palette,
	ShieldCheck,
	Timer,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { masterPasswordRejectionMessage } from "../../../util/master-password-strength";
import { MasterPasswordMeter } from "../../components/ui/master-password-meter";
import { SelectField } from "../../components/ui/select-field";
import { TextField } from "../../components/ui/text-field";

interface PasswordFormValues {
	currentPassword: string;
	newPassword: string;
	confirmPassword: string;
}

interface SettingsProps {
	darkMode: boolean;
	onToggleTheme: () => void;
	autoLockMinutes: number;
	clipboardClearSeconds: number;
	breachCheckEnabled: boolean;
	offerToSave: boolean;
	// eTLD+1 hostnames the user has muted via the corner card's
	// "Never for this site" overflow action. Surfaced here so they can be
	// un-muted; the array drives a chip list with per-row removal.
	neverSaveSites: string[];
	totalEntries: number;
	// Installed extension version, shown on the About row. Injected by the
	// route rather than pulled from the manifest here so the screen stays
	// platform-agnostic.
	version: string;
	onChangeAutoLock: (minutes: number) => void;
	onChangeClipboardSeconds: (seconds: number) => void;
	onToggleBreachCheck: (enabled: boolean) => void;
	onToggleOfferToSave: (enabled: boolean) => void;
	onRemoveNeverSaveSite: (host: string) => void;
	onLockNow: () => Promise<void>;
	// Two-step contract so the UI can distinguish a wrong current password
	// (field-level error, recoverable) from a rotation failure (form-level
	// error, the user may need to retry or relock).
	onVerifyCurrentPassword: (currentPassword: string) => Promise<boolean>;
	onChangeMasterPassword: (newPassword: string) => Promise<void>;
	// FIDO2 / WebAuthn unlock — paired with the master password (or as a
	// total replacement once at least one key is registered). List + add +
	// revoke; each row gets a friendly label set at registration time.
	securityKeys: { slotIdB64: string; label: string; addedAt: number }[];
	onRegisterSecurityKey: (label: string) => Promise<void>;
	onRevokeSecurityKey: (slotIdB64: string) => Promise<void>;
	// Open the full-tab import flow (the file picker would dismiss the popup).
	onImport: () => void;
}

export function Settings({
	darkMode,
	onToggleTheme,
	autoLockMinutes,
	clipboardClearSeconds,
	breachCheckEnabled,
	offerToSave,
	neverSaveSites,
	totalEntries,
	version,
	onChangeAutoLock,
	onChangeClipboardSeconds,
	onToggleBreachCheck,
	onToggleOfferToSave,
	onRemoveNeverSaveSite,
	onLockNow,
	onVerifyCurrentPassword,
	onChangeMasterPassword,
	securityKeys,
	onRegisterSecurityKey,
	onRevokeSecurityKey,
	onImport,
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
									<option value="30">30 seconds</option>
									<option value="60">1 minute</option>
									<option value="120">2 minutes</option>
									<option value="300">5 minutes</option>
								</SelectField>
							</div>
						</Row>

						{/* Breach check — opt-in (default off). The only network egress
						    in the app, so the subtitle is explicit about what's sent. */}
						<Row
							icon={<ShieldCheck className="w-4 h-4 text-primary" />}
							title="Check passwords for breaches"
							subtitle="Sends a 5-char SHA-1 prefix of each saved password to haveibeenpwned.com (k-anonymity — the password itself never leaves the device). The only off-device traffic in the app."
						>
							<Toggle
								checked={breachCheckEnabled}
								onChange={onToggleBreachCheck}
								label="Toggle breach checks"
							/>
						</Row>

						{/* Offer to save logins — drives the corner-prompt card. */}
						<Row
							icon={<ShieldCheck className="w-4 h-4 text-primary" />}
							title="Offer to save logins"
							subtitle="Show a save / update card in the corner of the page when you sign in with credentials Vault doesn't have."
						>
							<Toggle
								checked={offerToSave}
								onChange={onToggleOfferToSave}
								label="Toggle offer to save logins"
							/>
						</Row>

						{neverSaveSites.length > 0 && (
							<Row
								icon={<ShieldCheck className="w-4 h-4 text-primary" />}
								title="Sites you've muted"
								subtitle={`No save card on these ${neverSaveSites.length === 1 ? "site" : "sites"}. Remove to start prompting again.`}
							>
								<div className="flex flex-wrap gap-1.5 justify-end max-w-[12rem]">
									{neverSaveSites.map((host) => (
										<button
											key={host}
											type="button"
											onClick={() => onRemoveNeverSaveSite(host)}
											className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-md border border-border hover:bg-primary/5 hover:border-primary/50 transition-all"
											title={`Remove ${host} from never-save list`}
										>
											{host}
											<span aria-hidden>×</span>
										</button>
									))}
								</div>
							</Row>
						)}

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
								<div>
									<TextField
										label="New password"
										type="password"
										autoComplete="new-password"
										error={errors.newPassword?.message}
										{...register("newPassword", {
											required: "Enter a new password",
											// Same strength floor as vault setup (master-password-strength)
											// so rotating to a weaker password isn't possible.
											validate: masterPasswordRejectionMessage,
										})}
									/>
									<MasterPasswordMeter value={newPasswordValue ?? ""} />
								</div>
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

						<SecurityKeysSection
							securityKeys={securityKeys}
							onRegister={onRegisterSecurityKey}
							onRevoke={onRevokeSecurityKey}
						/>
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

				{/* Data */}
				<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
					<div className="px-4 py-3 border-b border-border/50">
						<h3 className="text-sm flex items-center gap-2">
							<Download className="w-4 h-4 text-primary" />
							Data
						</h3>
					</div>
					<div className="p-4">
						<Row
							icon={<Download className="w-4 h-4 text-primary" />}
							title="Import from another manager"
							subtitle="Bring entries in from 1Password, Bitwarden, KeePass or Proton Pass"
						>
							<button
								type="button"
								onClick={onImport}
								className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all"
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
							<span>{version}</span>
						</div>
						<div className="flex items-center justify-between text-sm">
							<span className="text-muted-foreground">Total entries</span>
							<span>{totalEntries}</span>
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
				className={`absolute top-0.5 w-5 h-5 rounded-full bg-card shadow-sm transition-all ${
					checked ? "left-5 dark:bg-primary-foreground" : "left-0.5 dark:bg-card-foreground"
				}`}
			/>
		</button>
	);
}

interface SecurityKeysSectionProps {
	securityKeys: { slotIdB64: string; label: string; addedAt: number }[];
	onRegister: (label: string) => Promise<void>;
	onRevoke: (slotIdB64: string) => Promise<void>;
}

function SecurityKeysSection({ securityKeys, onRegister, onRevoke }: SecurityKeysSectionProps) {
	const [adding, setAdding] = useState(false);
	const [label, setLabel] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleAdd = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		setBusy(true);
		try {
			await onRegister(label.trim() || "Security key");
			setLabel("");
			setAdding(false);
		} catch (err) {
			setError(String(err instanceof Error ? err.message : err));
		} finally {
			setBusy(false);
		}
	};

	const handleRevoke = async (slotIdB64: string) => {
		setError(null);
		try {
			await onRevoke(slotIdB64);
		} catch (err) {
			setError(String(err instanceof Error ? err.message : err));
		}
	};

	return (
		<>
			<Row
				icon={<KeyRound className="w-4 h-4 text-primary" />}
				title="Security keys"
				subtitle="Tap a YubiKey or use Windows Hello to unlock instead of typing the master password."
			>
				{!adding ? (
					<button
						type="button"
						onClick={() => {
							setError(null);
							setAdding(true);
						}}
						className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all"
					>
						Add
					</button>
				) : null}
			</Row>

			{securityKeys.length > 0 && (
				<ul className="ml-12 mt-2 space-y-1.5">
					{securityKeys.map((k) => (
						<li
							key={k.slotIdB64}
							className="flex items-center justify-between gap-3 text-xs rounded-md border border-border/40 px-3 py-1.5"
						>
							<span className="truncate">{k.label}</span>
							<button
								type="button"
								onClick={() => void handleRevoke(k.slotIdB64)}
								className="text-muted-foreground hover:text-destructive transition-colors"
								aria-label={`Remove ${k.label}`}
								title={`Remove ${k.label}`}
							>
								×
							</button>
						</li>
					))}
				</ul>
			)}

			{adding && (
				<form className="ml-12 mt-3 space-y-2" onSubmit={handleAdd}>
					<input
						type="text"
						autoFocus
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						placeholder="Name this key (e.g. YubiKey office)"
						className="w-full px-3 py-1.5 text-xs rounded-lg border border-border bg-transparent focus:outline-none focus:border-primary/50"
						disabled={busy}
					/>
					<div className="flex gap-2">
						<button
							type="submit"
							disabled={busy}
							className="px-3 py-1.5 text-xs rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 disabled:opacity-50"
						>
							{busy ? "Tap your key…" : "Register"}
						</button>
						<button
							type="button"
							onClick={() => {
								setAdding(false);
								setLabel("");
								setError(null);
							}}
							disabled={busy}
							className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 disabled:opacity-50"
						>
							Cancel
						</button>
					</div>
				</form>
			)}

			{error && <p className="ml-12 mt-2 text-xs text-destructive">{error}</p>}
		</>
	);
}
