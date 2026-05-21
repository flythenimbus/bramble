import { Eye, EyeOff, Shield } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { TextField } from "../../components/ui/text-field";

interface AuthProps {
	hasVault: boolean;
	onUnlock: (password: string) => Promise<void>;
	onOpenSetup: () => Promise<void>;
}

interface FormValues {
	masterPassword: string;
}

export function Auth({ hasVault, onUnlock, onOpenSetup }: AuthProps) {
	const [showPassword, setShowPassword] = useState(false);
	const [busy, setBusy] = useState(false);
	const {
		register,
		handleSubmit,
		formState: { errors },
		setError,
		resetField,
	} = useForm<FormValues>({ defaultValues: { masterPassword: "" } });

	const onSubmit = async ({ masterPassword }: FormValues) => {
		setBusy(true);
		try {
			await onUnlock(masterPassword);
		} catch (e) {
			setError("masterPassword", { message: (e as Error).message });
			resetField("masterPassword");
		} finally {
			setBusy(false);
		}
	};

	const handleOpenSetup = async () => {
		setBusy(true);
		try {
			await onOpenSetup();
		} catch (e) {
			setError("masterPassword", { message: (e as Error).message });
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center p-4">
			<div className="w-full max-w-md">
				<div className="text-center mb-8">
					<div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-primary/80 mb-4">
						<Shield className="w-9 h-9 text-primary-foreground" />
					</div>
					<h1 className="text-2xl mb-2 bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
						Welcome to PassGuard
					</h1>
					<p className="text-sm text-muted-foreground">
						Enter your master password to unlock your vault
					</p>
				</div>

				<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
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
							className="w-full px-5 py-3 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{busy ? "Unlocking…" : hasVault ? "Unlock Vault" : "No vault — create one below"}
						</button>
					</form>
				</div>

				<div className="mt-6 text-center space-y-3">
					<button
						type="button"
						className="text-sm text-primary hover:underline active:scale-[0.98] transition-all"
					>
						Forgot master password?
					</button>

					<div className="flex items-center gap-4 text-xs text-muted-foreground">
						<div className="flex-1 h-px bg-border/50"></div>
						<span>New to PassGuard?</span>
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

				<div className="mt-8 p-4 rounded-lg border border-border/30 bg-card/30 backdrop-blur-sm">
					<div className="flex items-start gap-3">
						<div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 flex-shrink-0">
							<Shield className="w-4 h-4 text-primary" />
						</div>
						<div>
							<h4 className="text-xs mb-1">Encrypted on your device</h4>
							<p className="text-xs text-muted-foreground leading-relaxed">
								Your vault stays on this device, encrypted with AES-256-GCM. Only your master
								password can unlock it, so keep it somewhere safe.
							</p>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
