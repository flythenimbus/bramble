import { Shield } from "lucide-react";
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import {
	masterPasswordHardError,
	masterPasswordWarning,
} from "../../../../util/master-password-strength";
import { MasterPasswordMeter } from "../../../components/ui/master-password-meter";
import { TextField } from "../../../components/ui/text-field";
import { WeakPasswordNotice } from "../../../components/ui/weak-password-notice";
import type { VaultSetupFormValues, VaultSetupMode } from "../types";

interface PasswordCardProps {
	mode: VaultSetupMode;
	form: UseFormReturn<VaultSetupFormValues>;
	busy: boolean;
	canSubmit: boolean;
	submitError: string | null;
	onSubmit: (values: VaultSetupFormValues) => Promise<void>;
}

/** Master-password form card for vault setup, gating weak passwords on create only. */
export function PasswordCard({
	mode,
	form,
	busy,
	canSubmit,
	submitError,
	onSubmit,
}: PasswordCardProps) {
	const {
		register,
		handleSubmit,
		watch,
		formState: { errors },
	} = form;
	const isCreate = mode === "create";
	const pw = watch("masterPassword");
	// Weak (but allowed) passwords warn + require an explicit opt-in, only on
	// creation. Unlock never gates an existing password.
	const weakWarning = isCreate ? masterPasswordWarning(pw ?? "") : undefined;
	const [acceptedWeak, setAcceptedWeak] = useState(false);
	const blockedByWeak = !!weakWarning && !acceptedWeak;

	return (
		<form onSubmit={handleSubmit(onSubmit)}>
			<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
				<div className="px-5 py-3 border-b border-border/50">
					<h3 className="text-sm flex items-center gap-2">
						<Shield className="w-4 h-4 text-primary" />
						2. {isCreate ? "Master password" : "Your master password"}
					</h3>
				</div>
				<div className="p-5 space-y-4">
					<div>
						<TextField
							label="Master password"
							type="password"
							autoComplete={isCreate ? "new-password" : "current-password"}
							error={errors.masterPassword?.message}
							{...register("masterPassword", {
								required: isCreate ? "Choose a master password" : "Enter your master password",
								// Only the hard floor (too short) blocks creation; weakness is a
								// warning below. Unlock skips it entirely: existing vaults may
								// predate any policy.
								validate: isCreate ? masterPasswordHardError : undefined,
							})}
						/>
						{isCreate && <MasterPasswordMeter value={pw ?? ""} />}
					</div>
					{isCreate && (
						<TextField
							label="Confirm master password"
							type="password"
							autoComplete="new-password"
							error={errors.confirmPassword?.message}
							{...register("confirmPassword", {
								required: "Re-enter the password",
								validate: (v) => v === pw || "passwords don't match",
							})}
						/>
					)}
					{weakWarning && (
						<WeakPasswordNotice
							message={weakWarning}
							accepted={acceptedWeak}
							onAccept={setAcceptedWeak}
						/>
					)}
					{isCreate && <NoRecoveryWarning />}
				</div>

				<div className="px-5 py-4 bg-muted/30 border-t border-border/50 flex items-center justify-end gap-3">
					{submitError && (
						<p className="flex-1 text-xs text-destructive truncate" title={submitError}>
							{submitError}
						</p>
					)}
					<button
						type="submit"
						disabled={busy || !canSubmit || blockedByWeak}
						className="px-5 py-2 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
					>
						<SubmitLabel mode={mode} busy={busy} />
					</button>
				</div>
			</div>
		</form>
	);
}

function SubmitLabel({ mode, busy }: { mode: VaultSetupMode; busy: boolean }) {
	if (busy) return <>{mode === "create" ? "Creating…" : "Unlocking…"}</>;
	return <>{mode === "create" ? "Create vault" : "Unlock vault"}</>;
}

function NoRecoveryWarning() {
	return (
		<div className="rounded-md p-3 bg-destructive/5 border border-destructive/30 text-xs text-muted-foreground">
			<span className="text-destructive">⚠</span> There's no vendor reset. Memorize this password
			and keep the recovery code you'll get next somewhere safe. If you lose both, your vault can't
			be recovered.
		</div>
	);
}
