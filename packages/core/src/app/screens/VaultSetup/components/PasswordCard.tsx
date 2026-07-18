import { Trans, useLingui } from "@lingui/react/macro";
import { Shield } from "lucide-react";
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import {
	masterPasswordHardError,
	masterPasswordWarning,
} from "../../../../util/master-password-strength";
import { Button } from "../../../components/ui/button";
import { MasterPasswordMeter } from "../../../components/ui/master-password-meter";
import { PasswordField } from "../../../components/ui/password-field";
import { WeakPasswordNotice } from "../../../components/ui/weak-password-notice";
import type { VaultSetupFormValues } from "../types";

interface PasswordCardProps {
	form: UseFormReturn<VaultSetupFormValues>;
	busy: boolean;
	submitError: string | null;
	onSubmit: (values: VaultSetupFormValues) => Promise<void>;
	/** Compact/mobile presentation: column footer, full-width button, larger heading. */
	mobile?: boolean;
	/** Show an optional vault-name field (when adding a parallel vault). */
	showName?: boolean;
}

/** Master-password form card for creating a vault; gates weak passwords behind an explicit opt-in.
 * Opening an existing vault is the separate "Restore from backup" flow, not this card. */
export function PasswordCard({
	form,
	busy,
	submitError,
	onSubmit,
	mobile,
	showName,
}: PasswordCardProps) {
	const { t } = useLingui();
	const {
		register,
		handleSubmit,
		watch,
		formState: { errors },
	} = form;
	const pw = watch("masterPassword");
	// Weak (but allowed) passwords warn + require an explicit opt-in before creation.
	const weakWarning = masterPasswordWarning(pw ?? "");
	const [acceptedWeak, setAcceptedWeak] = useState(false);
	const blockedByWeak = !!weakWarning && !acceptedWeak;

	return (
		<form onSubmit={handleSubmit(onSubmit)}>
			<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
				<div className="px-5 py-3 border-b border-border/50">
					<h3 className={`flex items-center gap-2 ${mobile ? "text-base" : "text-sm"}`}>
						<Shield className="w-4 h-4 text-primary" />
						<Trans>Master password</Trans>
					</h3>
				</div>
				<div className="p-5 space-y-4">
					{showName && (
						<div>
							<label htmlFor="vault-name" className="block text-sm mb-1.5">
								<Trans>Vault name</Trans>
							</label>
							<input
								id="vault-name"
								type="text"
								placeholder={t`Optional (e.g. Work)`}
								autoComplete="off"
								className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-transparent focus:outline-none focus:border-primary/50"
								{...register("label")}
							/>
						</div>
					)}
					<div>
						<PasswordField
							label={t`Master password`}
							error={errors.masterPassword?.message}
							{...register("masterPassword", {
								required: t`Choose a master password`,
								// Only the hard floor (too short) blocks creation; weakness is a warning below.
								validate: masterPasswordHardError,
							})}
						/>
						<MasterPasswordMeter value={pw ?? ""} />
					</div>
					<PasswordField
						label={t`Confirm master password`}
						error={errors.confirmPassword?.message}
						{...register("confirmPassword", {
							required: t`Re-enter the password`,
							validate: (v) => v === pw || t`passwords don't match`,
						})}
					/>
					{weakWarning && (
						<WeakPasswordNotice
							message={weakWarning}
							accepted={acceptedWeak}
							onAccept={setAcceptedWeak}
						/>
					)}
					<NoRecoveryWarning />
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
					<Button
						type="submit"
						variant="primary"
						size={mobile ? "lg" : "md"}
						fullWidth={mobile}
						disabled={busy || blockedByWeak}
					>
						{busy ? <Trans>Creating…</Trans> : <Trans>Create vault</Trans>}
					</Button>
				</div>
			</div>
		</form>
	);
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
