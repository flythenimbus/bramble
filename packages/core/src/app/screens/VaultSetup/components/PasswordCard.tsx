import { Trans, useLingui } from "@lingui/react/macro";
import { Shield } from "lucide-react";
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import {
	masterPasswordHardError,
	masterPasswordWarning,
} from "../../../../util/master-password-strength";
import { MasterPasswordMeter } from "../../../components/ui/master-password-meter";
import { PasswordField } from "../../../components/ui/password-field";
import { WeakPasswordNotice } from "../../../components/ui/weak-password-notice";
import type { VaultSetupFormValues, VaultSetupMode } from "../types";

interface PasswordCardProps {
	mode: VaultSetupMode;
	form: UseFormReturn<VaultSetupFormValues>;
	busy: boolean;
	submitError: string | null;
	onSubmit: (values: VaultSetupFormValues) => Promise<void>;
	/** Compact/mobile presentation: column footer, full-width button, larger heading. */
	mobile?: boolean;
}

/** Master-password form card for vault setup, gating weak passwords on create only. */
export function PasswordCard({
	mode,
	form,
	busy,
	submitError,
	onSubmit,
	mobile,
}: PasswordCardProps) {
	const { t } = useLingui();
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
					<h3 className={`flex items-center gap-2 ${mobile ? "text-base" : "text-sm"}`}>
						<Shield className="w-4 h-4 text-primary" />
						{isCreate ? <Trans>Master password</Trans> : <Trans>Your master password</Trans>}
					</h3>
				</div>
				<div className="p-5 space-y-4">
					<div>
						<PasswordField
							label={t`Master password`}
							autoComplete={isCreate ? "new-password" : "current-password"}
							error={errors.masterPassword?.message}
							{...register("masterPassword", {
								required: isCreate ? t`Choose a master password` : t`Enter your master password`,
								// Only the hard floor (too short) blocks creation; weakness is a
								// warning below. Unlock skips it entirely: existing vaults may
								// predate any policy.
								validate: isCreate ? masterPasswordHardError : undefined,
							})}
						/>
						{isCreate && <MasterPasswordMeter value={pw ?? ""} />}
					</div>
					{isCreate && (
						<PasswordField
							label={t`Confirm master password`}
							autoComplete="new-password"
							error={errors.confirmPassword?.message}
							{...register("confirmPassword", {
								required: t`Re-enter the password`,
								validate: (v) => v === pw || t`passwords don't match`,
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

				<div
					className={`px-5 py-4 bg-muted/30 border-t border-border/50 flex gap-3 ${
						mobile ? "flex-col items-stretch" : "items-center justify-end"
					}`}
				>
					{submitError && (
						<p
							className={`text-destructive ${mobile ? "text-sm" : "flex-1 text-xs truncate"}`}
							title={submitError}
						>
							{submitError}
						</p>
					)}
					<button
						type="submit"
						disabled={busy || blockedByWeak}
						className={`rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
							mobile ? "w-full px-5 py-3 text-base" : "px-5 py-2 text-sm"
						}`}
					>
						<SubmitLabel mode={mode} busy={busy} />
					</button>
				</div>
			</div>
		</form>
	);
}

function SubmitLabel({ mode, busy }: { mode: VaultSetupMode; busy: boolean }) {
	if (busy) return <>{mode === "create" ? <Trans>Creating…</Trans> : <Trans>Unlocking…</Trans>}</>;
	return <>{mode === "create" ? <Trans>Create vault</Trans> : <Trans>Unlock vault</Trans>}</>;
}

function NoRecoveryWarning() {
	return (
		<div className="rounded-md p-3 bg-destructive/5 border border-destructive/30 text-xs text-muted-foreground">
			<span className="text-destructive">⚠</span>{" "}
			<Trans>
				There's no vendor reset. Memorize this password and keep the recovery code you'll get next
				somewhere safe. If you lose both, your vault can't be recovered.
			</Trans>
		</div>
	);
}
