import { ExternalLink, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { TextField } from "../../components/ui/text-field";

interface AuthProps {
	hasVault: boolean;
	onUnlock: (password: string) => Promise<void>;
	onOpenSetup: () => Promise<void>;
	onPopOut?: () => void;
}

interface FormValues {
	masterPassword: string;
}

export function Auth({ hasVault, onUnlock, onOpenSetup, onPopOut }: AuthProps) {
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
		<div className="relative h-screen overflow-y-auto bg-gradient-to-br from-background via-background to-primary/5">
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
			<div className="min-h-full flex items-center justify-center px-6 py-10">
				<div className="w-full max-w-md">
					<div className="text-center mb-6">
						<h1 className="text-xl bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
							Enter your master password to unlock your vault
						</h1>
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
				</div>
			</div>
		</div>
	);
}
