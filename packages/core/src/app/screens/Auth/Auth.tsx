import { Asterisk, ExternalLink, Eye, EyeOff, KeyRound, Shield } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { usePlatform } from "../../../context/PlatformContext";
import { useVault } from "../../../hooks/useVault";
import { TextField } from "../../components/ui/text-field";
import { usePopOut } from "../../hooks/usePopOut";

interface FormValues {
	masterPassword: string;
}

export function Auth() {
	const {
		hasVault,
		unlock,
		hasPasswordSlot,
		hasWebauthnSlot,
		unlockWithSecurityKey,
		hasRecoveryCode,
		unlockWithRecoveryCode,
	} = useVault();
	const { shell } = usePlatform();
	const { popOut, canPopOut } = usePopOut();
	const appName = shell.appName;
	const onPopOut = canPopOut ? popOut : undefined;

	const [showPassword, setShowPassword] = useState(false);
	const [busy, setBusy] = useState(false);
	const [showRecovery, setShowRecovery] = useState(false);
	const [recoveryCode, setRecoveryCode] = useState("");
	const [recoveryError, setRecoveryError] = useState<string | null>(null);
	const {
		register,
		handleSubmit,
		formState: { errors },
		setError,
	} = useForm<FormValues>({ defaultValues: { masterPassword: "" } });

	const onSubmit = async ({ masterPassword }: FormValues) => {
		setBusy(true);
		try {
			await unlock(masterPassword);
		} catch (e) {
			setError("masterPassword", { message: (e as Error).message }, { shouldFocus: true });
		} finally {
			setBusy(false);
		}
	};

	const handleOpenSetup = async () => {
		setBusy(true);
		try {
			await shell.openSetup();
		} catch (e) {
			setError("masterPassword", { message: (e as Error).message });
		} finally {
			setBusy(false);
		}
	};

	const handleSecurityKey = async () => {
		setBusy(true);
		try {
			await unlockWithSecurityKey();
		} catch (e) {
			setError("masterPassword", { message: (e as Error).message });
		} finally {
			setBusy(false);
		}
	};

	const handleRecovery = async (e: React.FormEvent) => {
		e.preventDefault();
		setRecoveryError(null);
		setBusy(true);
		try {
			await unlockWithRecoveryCode(recoveryCode);
		} catch (err) {
			setRecoveryError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};

	const showPasswordForm = hasVault && hasPasswordSlot;
	const securityKeyAvailable = hasVault && hasWebauthnSlot;
	const recoveryAvailable = hasVault && hasRecoveryCode;

	return (
		<div className="relative h-screen overflow-y-auto bg-linear-to-br from-background via-background to-primary/5">
			{onPopOut && (
				<button
					type="button"
					onClick={onPopOut}
					className="absolute top-3 right-3 z-10 p-2 rounded-lg border border-transparent text-muted-foreground hover:bg-primary/10 hover:border-border hover:text-foreground active:scale-[0.95] transition-all"
					aria-label="Open in window"
					title="Open in window"
				>
					<ExternalLink className="w-4 h-4" />
				</button>
			)}
			<div className="px-6 py-6">
				<div className="w-full max-w-md mx-auto">
					<div className="mb-5">
						<div className="flex justify-center mb-3">
							<div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-linear-to-br from-primary to-primary/80">
								<Shield className="w-8 h-8 text-primary-foreground" />
							</div>
						</div>
						<h1 className="text-xl bg-linear-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
							{showPasswordForm
								? "Enter your master password to unlock your vault"
								: "Unlock your vault with your security key"}
						</h1>
					</div>

					<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
						{showPasswordForm && (
							<form onSubmit={handleSubmit(onSubmit)} className="p-6 space-y-5">
								<TextField
									label="Master password"
									type={showPassword ? "text" : "password"}
									autoFocus
									error={errors.masterPassword?.message}
									endAdornment={
										<button
											type="button"
											onClick={() => setShowPassword(!showPassword)}
											className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
											aria-label={showPassword ? "Hide password" : "Show password"}
										>
											{showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
										</button>
									}
									{...register("masterPassword", {
										required: "Please enter your master password",
									})}
								/>

								<button
									type="submit"
									disabled={busy || !hasVault}
									className="w-full px-5 py-3 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
								>
									<Asterisk className="w-4 h-4" />
									{busy
										? "Unlocking…"
										: !hasVault
											? "No vault, create one below"
											: securityKeyAvailable
												? "Unlock with master password"
												: "Unlock Vault"}
								</button>
							</form>
						)}

						{securityKeyAvailable && (
							<div className={showPasswordForm ? "px-6 pb-6 -mt-3" : "p-6"}>
								<button
									type="button"
									onClick={handleSecurityKey}
									disabled={busy}
									className={
										showPasswordForm
											? "w-full px-5 py-3 text-sm rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50"
											: "w-full px-5 py-3 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
									}
								>
									<KeyRound className="w-4 h-4" />
									{busy ? "Waiting for your key…" : "Unlock with security key"}
								</button>
							</div>
						)}
					</div>

					{recoveryAvailable && (
						<div className="mt-4">
							{!showRecovery ? (
								<button
									type="button"
									onClick={() => {
										setRecoveryError(null);
										setShowRecovery(true);
									}}
									className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
								>
									Unlock with recovery code
								</button>
							) : (
								<form
									onSubmit={handleRecovery}
									className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm p-4 space-y-2"
								>
									<p className="text-xs text-muted-foreground">
										Enter your recovery code to unlock. After signing in, generate a new one in
										Settings.
									</p>
									<input
										type="text"
										autoFocus
										value={recoveryCode}
										onChange={(e) => setRecoveryCode(e.target.value)}
										placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
										autoCapitalize="characters"
										autoComplete="off"
										spellCheck={false}
										disabled={busy}
										className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-border bg-transparent focus:outline-none focus:border-primary/50"
									/>
									{recoveryError && <p className="text-xs text-destructive">{recoveryError}</p>}
									<div className="flex gap-2">
										<button
											type="submit"
											disabled={busy || !recoveryCode.trim()}
											className="px-3 py-1.5 text-xs rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 disabled:opacity-50"
										>
											{busy ? "Unlocking…" : "Unlock"}
										</button>
										<button
											type="button"
											onClick={() => {
												setShowRecovery(false);
												setRecoveryCode("");
												setRecoveryError(null);
											}}
											disabled={busy}
											className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 disabled:opacity-50"
										>
											Cancel
										</button>
									</div>
								</form>
							)}
						</div>
					)}

					<div className="mt-6 text-center space-y-3">
						<div className="flex items-center gap-4 text-xs text-muted-foreground">
							<div className="flex-1 h-px bg-border/50"></div>
							<span>New to {appName}?</span>
							<div className="flex-1 h-px bg-border/50"></div>
						</div>

						<button
							type="button"
							onClick={handleOpenSetup}
							disabled={busy}
							className="text-sm text-foreground hover:text-primary active:scale-[0.98] transition-all disabled:opacity-50"
						>
							Create new vault
						</button>
					</div>

					<div className="mt-6 p-4 rounded-lg border border-border/30 bg-card/30 backdrop-blur-sm">
						<div className="flex items-start gap-3">
							<div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 shrink-0">
								<Shield className="w-4 h-4 text-primary" />
							</div>
							<div>
								<h4 className="text-xs mb-1">Encrypted on your device</h4>
								<p className="text-xs text-muted-foreground leading-relaxed">
									Your vault stays on this device, encrypted with AES-256-GCM. Keep your master
									password and recovery code somewhere safe.
								</p>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
