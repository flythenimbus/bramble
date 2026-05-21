import { Eye, EyeOff, Lock, Shield } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";

interface AuthProps {
	onAuthenticate: () => void;
}

interface FormValues {
	masterPassword: string;
}

export function Auth({ onAuthenticate }: AuthProps) {
	const [showPassword, setShowPassword] = useState(false);
	const {
		register,
		handleSubmit,
		formState: { errors },
		setError,
		resetField,
	} = useForm<FormValues>({ defaultValues: { masterPassword: "" } });

	const onSubmit = ({ masterPassword }: FormValues) => {
		// Mock authentication — real flow will call CryptoAdapter.unlock + verifier check.
		if (masterPassword.length >= 8) {
			onAuthenticate();
			return;
		}
		setError("masterPassword", { message: "Invalid master password" });
		resetField("masterPassword");
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
						<div>
							<label htmlFor="master-password" className="block text-sm mb-2">
								Master Password
							</label>
							<div className="relative">
								<div className="absolute left-3 top-1/2 -translate-y-1/2">
									<Lock className="w-4 h-4 text-muted-foreground/60" />
								</div>
								<input
									id="master-password"
									type={showPassword ? "text" : "password"}
									placeholder="Enter your master password"
									autoFocus
									className="w-full pl-10 pr-12 py-3 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
									{...register("masterPassword", {
										required: "Please enter your master password",
									})}
								/>
								<button
									type="button"
									onClick={() => setShowPassword(!showPassword)}
									className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
									aria-label={showPassword ? "Hide password" : "Show password"}
								>
									{showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
								</button>
							</div>
							{errors.masterPassword && (
								<p className="text-xs text-destructive mt-2">{errors.masterPassword.message}</p>
							)}
						</div>

						<button
							type="submit"
							className="w-full px-5 py-3 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all"
						>
							Unlock Vault
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
						className="text-sm text-foreground hover:text-primary active:scale-[0.98] transition-all"
					>
						Create new vault
					</button>
				</div>

				{/* TODO: remove once unlock flow is wired to the real CryptoAdapter. */}
				<button
					type="button"
					onClick={onAuthenticate}
					className="mt-6 px-2 py-1 text-[10px] uppercase tracking-wider font-mono bg-yellow-300 text-black border border-yellow-600 hover:bg-yellow-400"
				>
					[dev] skip auth
				</button>

				<div className="mt-8 p-4 rounded-lg border border-border/30 bg-card/30 backdrop-blur-sm">
					<div className="flex items-start gap-3">
						<div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 flex-shrink-0">
							<Shield className="w-4 h-4 text-primary" />
						</div>
						<div>
							<h4 className="text-xs mb-1">Your data is encrypted</h4>
							<p className="text-xs text-muted-foreground leading-relaxed">
								We use end-to-end encryption. Only you can access your vault with your master
								password.
							</p>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
