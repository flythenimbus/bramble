import { Trans, useLingui } from "@lingui/react/macro";
import { AlertTriangle, Asterisk } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useVault } from "../../../../hooks/useVault";
import {
	masterPasswordHardError,
	masterPasswordWarning,
} from "../../../../util/master-password-strength";
import { MasterPasswordMeter } from "../../../components/ui/master-password-meter";
import { Modal } from "../../../components/ui/modal";
import { PasswordField } from "../../../components/ui/password-field";
import { WeakPasswordNotice } from "../../../components/ui/weak-password-notice";
import { Row, Toggle } from "./primitives";

interface PwFormValues {
	currentPassword: string;
	newPassword: string;
	confirmPassword: string;
}

/** Settings section for setting, changing, or disabling the vault's master password. */
export function MasterPasswordSection() {
	const {
		hasPasswordSlot,
		securityKeys,
		verifyMasterPassword,
		changeMasterPassword,
		setMasterPassword,
		disableMasterPassword,
	} = useVault();
	const { t } = useLingui();
	const hasSecurityKey = securityKeys.length > 0;
	// "change" reveals current+new+confirm; "set" reveals new+confirm (re-enable
	// or first-time on a key-only vault); null = form closed.
	const [formMode, setFormMode] = useState<null | "change" | "set">(null);
	const [pwSuccess, setPwSuccess] = useState<null | "changed" | "set">(null);
	const [formError, setFormError] = useState<string | null>(null);
	const [confirmingDisable, setConfirmingDisable] = useState(false);
	const [disableError, setDisableError] = useState<string | null>(null);
	const [disabling, setDisabling] = useState(false);
	const [acceptedWeak, setAcceptedWeak] = useState(false);
	const formErrorRef = useRef<HTMLDivElement>(null);

	const {
		register,
		handleSubmit,
		reset,
		setError,
		watch,
		formState: { errors, isSubmitting },
	} = useForm<PwFormValues>({
		defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
	});
	const newPasswordValue = watch("newPassword");
	const weakWarning = masterPasswordWarning(newPasswordValue ?? "");
	const blockedByWeak = !!weakWarning && !acceptedWeak;

	useEffect(() => {
		if (formError) {
			formErrorRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
		}
	}, [formError]);

	const closeForm = () => {
		setFormMode(null);
		setFormError(null);
		setAcceptedWeak(false);
		reset();
	};

	const onSubmit = async ({ currentPassword, newPassword }: PwFormValues) => {
		setFormError(null);
		setPwSuccess(null);
		try {
			if (formMode === "change") {
				const ok = await verifyMasterPassword(currentPassword);
				if (!ok) {
					setError(
						"currentPassword",
						{ message: t`Current password is incorrect` },
						{ shouldFocus: true },
					);
					return;
				}
				await changeMasterPassword(newPassword);
				setPwSuccess("changed");
			} else {
				await setMasterPassword(newPassword);
				setPwSuccess("set");
			}
			reset();
			setFormMode(null);
		} catch (e) {
			setFormError((e as Error).message);
		}
	};

	// The toggle mirrors whether a master password exists. Turning it on for a
	// key-only vault opens the set form; turning it off (when a key exists to
	// fall back on) opens the disable confirmation.
	const onToggle = (next: boolean) => {
		setPwSuccess(null);
		if (next && !hasPasswordSlot) {
			setFormError(null);
			reset();
			setFormMode("set");
		} else if (!next && hasPasswordSlot && hasSecurityKey) {
			setDisableError(null);
			setConfirmingDisable(true);
		}
	};

	const confirmDisable = async () => {
		setDisableError(null);
		setDisabling(true);
		try {
			await disableMasterPassword();
			setConfirmingDisable(false);
		} catch (e) {
			setDisableError((e as Error).message);
		} finally {
			setDisabling(false);
		}
	};

	return (
		<>
			<Row
				icon={<Asterisk className="w-4 h-4 text-primary" />}
				title={t`Master password`}
				subtitle={
					hasPasswordSlot
						? t`Required to unlock your vault.`
						: t`Off. You unlock with a security key.`
				}
			>
				<Toggle
					checked={hasPasswordSlot}
					onChange={onToggle}
					disabled={hasPasswordSlot && !hasSecurityKey}
					label={t`Require master password to unlock`}
				/>
			</Row>

			{hasPasswordSlot && formMode !== "change" && (
				<div className="ml-12 mt-2 flex items-center justify-between gap-3 text-xs rounded-md border border-border/40 pl-3 pr-1.5 py-1.5">
					<span className="truncate text-muted-foreground">
						<Trans>Change your master password</Trans>
					</span>
					<button
						type="button"
						onClick={() => {
							reset();
							setFormError(null);
							setPwSuccess(null);
							setFormMode("change");
						}}
						className="px-2.5 py-1 text-xs rounded-md border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all"
					>
						<Trans>Change</Trans>
					</button>
				</div>
			)}

			{hasPasswordSlot && !hasSecurityKey && (
				<p className="text-xs text-muted-foreground pl-12">
					<Trans>Register a security key below before you can turn off the master password.</Trans>
				</p>
			)}

			{pwSuccess && !formMode && (
				<p className="text-xs text-primary pl-12">
					{pwSuccess === "changed" ? t`Master password updated.` : t`Master password set.`}
				</p>
			)}

			{formMode && (
				<form className="ml-12 space-y-3 pt-1" onSubmit={handleSubmit(onSubmit)} noValidate>
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
					{formMode === "change" && (
						<PasswordField
							label={t`Current password`}
							autoComplete="current-password"
							autoFocus
							error={errors.currentPassword?.message}
							{...register("currentPassword", { required: t`Enter your current password` })}
						/>
					)}
					<div>
						<PasswordField
							label={t`New password`}
							autoComplete="new-password"
							autoFocus={formMode === "set"}
							error={errors.newPassword?.message}
							{...register("newPassword", {
								required: t`Enter a new password`,
								// Only the hard floor (too short) blocks; weakness warns below.
								validate: masterPasswordHardError,
							})}
						/>
						<MasterPasswordMeter value={newPasswordValue ?? ""} />
					</div>
					<PasswordField
						label={t`Confirm new password`}
						autoComplete="new-password"
						error={errors.confirmPassword?.message}
						{...register("confirmPassword", {
							required: t`Confirm your new password`,
							validate: (value) => value === newPasswordValue || t`Passwords don't match`,
						})}
					/>
					{weakWarning && (
						<WeakPasswordNotice
							message={weakWarning}
							accepted={acceptedWeak}
							onAccept={setAcceptedWeak}
						/>
					)}
					<div className="flex items-center justify-end gap-2">
						<button
							type="button"
							onClick={closeForm}
							disabled={isSubmitting}
							className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-background/50 active:scale-[0.98] transition-all disabled:opacity-50"
						>
							<Trans>Cancel</Trans>
						</button>
						<button
							type="submit"
							disabled={isSubmitting || blockedByWeak}
							className="px-3 py-1.5 text-xs rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50"
						>
							{isSubmitting
								? t`Saving…`
								: formMode === "change"
									? t`Update password`
									: t`Set password`}
						</button>
					</div>
				</form>
			)}

			<Modal open={confirmingDisable} onClose={() => setConfirmingDisable(false)}>
				<div className="p-6 space-y-4">
					<div className="flex items-start gap-3">
						<div className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-destructive/15 shrink-0">
							<AlertTriangle className="w-5 h-5 text-destructive" />
						</div>
						<div>
							<h2 className="text-base">
								<Trans>Disable master password?</Trans>
							</h2>
							<p className="text-sm text-muted-foreground mt-1">
								<Trans>
									You'll unlock this vault with your security key only. If you lose all your
									security keys, your recovery code is the only way back in. There's no master
									password to fall back on.
								</Trans>
							</p>
						</div>
					</div>
					{disableError && <p className="text-xs text-destructive">{disableError}</p>}
					<div className="flex items-center justify-end gap-2">
						<button
							type="button"
							onClick={() => setConfirmingDisable(false)}
							disabled={disabling}
							className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-background/50 disabled:opacity-50"
						>
							<Trans>Cancel</Trans>
						</button>
						<button
							type="button"
							onClick={() => void confirmDisable()}
							disabled={disabling}
							className="px-3 py-1.5 text-xs rounded-lg bg-destructive text-white border border-destructive/20 hover:bg-destructive/90 disabled:opacity-50"
						>
							{disabling ? t`Disabling…` : t`Disable master password`}
						</button>
					</div>
				</div>
			</Modal>
		</>
	);
}
