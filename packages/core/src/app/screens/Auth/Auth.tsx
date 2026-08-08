import { Trans, useLingui } from "@lingui/react/macro";
import {
	Asterisk,
	ExternalLink,
	Fingerprint,
	KeyRound,
	LockKeyhole,
	Plus,
	ScanFace,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useCan, usePlatform } from "../../../context/PlatformContext";
import { useCryptoErrorMessage } from "../../../hooks/useCryptoErrorMessage";
import { useVault } from "../../../hooks/useVault";
import { useVaultRegistry } from "../../../hooks/useVaultRegistry";
import { displayLabel } from "../../../vault/vault-registry";
import { BrambleGlyph } from "../../components/BrambleGlyph";
import { Button } from "../../components/ui/button";
import { PasswordField } from "../../components/ui/password-field";
import { usePopOut } from "../../hooks/usePopOut";

interface FormValues {
	masterPassword: string;
}

/** Vault unlock screen: master password, security key, and recovery-code paths. */
export function Auth() {
	const {
		hasVault,
		unlock,
		hasPasswordSlot,
		hasWebauthnSlot,
		unlockWithSecurityKey,
		hasRecoveryCode,
		unlockWithRecoveryCode,
		biometricEnabled,
		biometricAvailable,
		biometryType,
		unlockWithBiometric,
		refreshBiometric,
		vaultError,
	} = useVault();
	const { shell } = usePlatform();
	// Clearing the selection returns to the picker (the auth guard redirects to /select).
	const { vaults, activeId, clearSelection } = useVaultRegistry();
	const multipleVaults = vaults.length > 1;
	// The vault this screen is unlocking, named in the top-left (mirrors the unlocked header).
	// Absent on first run, when there's no vault yet.
	const activeIndex = vaults.findIndex((v) => v.id === activeId);
	const vaultLabel =
		activeIndex >= 0 ? displayLabel(vaults[activeIndex]!.label, activeIndex) : null;
	const canSecurityKeys = useCan("securityKeys");
	const { popOut, canPopOut } = usePopOut();
	const { t } = useLingui();
	const cryptoError = useCryptoErrorMessage();
	const appName = shell.appName;
	const onPopOut = canPopOut ? popOut : undefined;

	// OS biometry can be turned off while backgrounded; re-probe on foreground so the button reflects it.
	useEffect(() => {
		const onVisible = () => {
			if (document.visibilityState === "visible") void refreshBiometric();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [refreshBiometric]);

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
			// Keep the typed value; the inline field error is the failure signal.
			// Do not resetField here: in RHF v7 it clears the error and makes failures silent.
			setError("masterPassword", { message: cryptoError(e) }, { shouldFocus: true });
		} finally {
			setBusy(false);
		}
	};

	const handleOpenSetup = async () => {
		setBusy(true);
		try {
			await shell.openSetup();
		} catch (e) {
			setError("masterPassword", { message: cryptoError(e) });
		} finally {
			setBusy(false);
		}
	};

	const handleSecurityKey = async () => {
		setBusy(true);
		try {
			await unlockWithSecurityKey();
		} catch (e) {
			// Surface in the same field-error region as a wrong master password.
			setError("masterPassword", { message: cryptoError(e) });
		} finally {
			setBusy(false);
		}
	};

	const handleBiometric = async () => {
		setBusy(true);
		try {
			await unlockWithBiometric();
		} catch (e) {
			// A user cancel surfaces here too; the password form stays available below.
			setError("masterPassword", { message: cryptoError(e) });
		} finally {
			setBusy(false);
		}
	};

	const handleRecovery = async (e: React.SyntheticEvent) => {
		e.preventDefault();
		setRecoveryError(null);
		setBusy(true);
		try {
			await unlockWithRecoveryCode(recoveryCode);
		} catch (err) {
			setRecoveryError(cryptoError(err));
		} finally {
			setBusy(false);
		}
	};

	const firstRun = !hasVault;
	const showDifferentVault = !firstRun && multipleVaults;
	// A vault exists but its blob couldn't be read yet (commonly an FSA file whose
	// read permission needs a user gesture). Rather than a scary error + extra step,
	// show the unlock controls optimistically: the unlock click is itself a gesture,
	// so it grants file access, reads, and unlocks in one go. We can't know which
	// methods the vault has until it's read, so offer both password and security key.
	const couldNotRead = hasVault && vaultError !== null && !hasPasswordSlot && !hasWebauthnSlot;
	const showPasswordForm = hasVault && (hasPasswordSlot || couldNotRead);
	// Security-key unlock is hidden where it can't work (mobile): no PRF, so offering it
	// would be a dead end even for a vault synced from desktop with a registered key.
	const securityKeyAvailable = hasVault && canSecurityKeys && (hasWebauthnSlot || couldNotRead);
	const recoveryAvailable = hasVault && hasRecoveryCode;
	// Device-local biometric is the fast path when set up; the password/security-key/
	// recovery methods stay as the fallback below it.
	const showBiometric = hasVault && biometricEnabled && biometricAvailable;
	// Label/icon track the enrolled modality: Face ID gets its own icon, a passcode-only
	// device (iOS, nothing enrolled) gets the lock, everything else the fingerprint.
	const isFaceId = biometryType === "faceId" || biometryType === "opticId";
	const BiometricIcon =
		biometryType === "passcode" ? LockKeyhole : isFaceId ? ScanFace : Fingerprint;
	const biometricLabel =
		biometryType === "faceId"
			? t`Unlock with Face ID`
			: biometryType === "opticId"
				? t`Unlock with Optic ID`
				: biometryType === "touchId"
					? t`Unlock with Touch ID`
					: biometryType === "passcode"
						? t`Unlock with passcode`
						: t`Unlock with biometrics`;

	return (
		<div className="relative h-screen overflow-y-auto bg-linear-to-br from-background via-background to-primary/5">
			{vaultLabel && (
				<div
					data-testid="active-vault-label"
					className="absolute top-3 left-4 z-10 flex h-8 max-w-[60%] items-center text-sm text-foreground/70"
				>
					<span className="truncate">{vaultLabel}</span>
				</div>
			)}
			{onPopOut && (
				<Button
					variant="ghost"
					size="icon"
					onClick={onPopOut}
					className="absolute top-3 right-3 z-10 text-muted-foreground hover:text-foreground"
					aria-label={t`Open in window`}
					title={t`Open in window`}
				>
					<ExternalLink className="w-4 h-4" />
				</Button>
			)}
			<div className="px-6 py-6">
				<div className="w-full max-w-md mx-auto">
					<div className="mb-5">
						<div className="flex justify-center mb-3">
							<BrambleGlyph className="w-16 h-16 text-foreground" />
						</div>
						<h1 className="text-xl bg-linear-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
							{firstRun
								? t`Welcome to ${appName}`
								: showPasswordForm
									? t`Enter your master password to unlock your vault`
									: t`Unlock your vault with your security key`}
						</h1>
						{firstRun && (
							<p className="mt-2 text-sm text-muted-foreground">
								<Trans>Set up a vault to start saving your passwords, cards, and notes.</Trans>
							</p>
						)}
					</div>

					{firstRun && (
						<Button
							variant="primary"
							size="lg"
							fullWidth
							onClick={handleOpenSetup}
							disabled={busy}
							className="text-sm"
						>
							<Plus className="w-4 h-4" />
							{busy ? t`Opening…` : t`Create your vault`}
						</Button>
					)}

					{!firstRun && (
						<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
							{showBiometric && (
								<div className={showPasswordForm || securityKeyAvailable ? "p-6 pb-0" : "p-6"}>
									<Button
										variant="primary"
										size="lg"
										fullWidth
										onClick={handleBiometric}
										disabled={busy}
										className="text-sm"
									>
										<BiometricIcon className="w-4 h-4" />
										{busy ? t`Verifying…` : biometricLabel}
									</Button>
								</div>
							)}
							{showPasswordForm && (
								<form onSubmit={handleSubmit(onSubmit)} className="p-6 space-y-5">
									<PasswordField
										label={t`Master password`}
										autoFocus
										error={errors.masterPassword?.message}
										{...register("masterPassword", {
											required: t`Please enter your master password`,
										})}
									/>

									<Button
										type="submit"
										variant={showBiometric ? "secondary" : "primary"}
										size="lg"
										fullWidth
										disabled={busy}
										className="text-sm"
									>
										<Asterisk className="w-4 h-4" />
										{busy
											? t`Unlocking…`
											: securityKeyAvailable || showBiometric
												? t`Unlock with master password`
												: t`Unlock Vault`}
									</Button>
								</form>
							)}

							{securityKeyAvailable && (
								<div className={showPasswordForm ? "px-6 pb-6 -mt-3" : "p-6"}>
									<Button
										variant={showPasswordForm ? "secondary" : "primary"}
										size="lg"
										fullWidth
										onClick={handleSecurityKey}
										disabled={busy}
										className="text-sm"
									>
										<KeyRound className="w-4 h-4" />
										{busy ? t`Waiting for your key…` : t`Unlock with security key`}
									</Button>
								</div>
							)}
						</div>
					)}

					{couldNotRead && (
						<p className="mt-3 text-center text-xs text-muted-foreground">
							<Trans>Your browser may ask for access to your vault file when you unlock.</Trans>
						</p>
					)}

					{(recoveryAvailable || showDifferentVault) && (
						<div className="mt-4">
							{recoveryAvailable && showRecovery ? (
								<form
									onSubmit={handleRecovery}
									className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm p-4 space-y-2"
								>
									<p className="text-xs text-muted-foreground">
										<Trans>
											Enter your recovery code to unlock. After signing in, generate a new one in
											Settings.
										</Trans>
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
										aria-label={t`Recovery code`}
										disabled={busy}
										className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-border bg-transparent focus:outline-none focus:border-primary/50"
									/>
									{recoveryError && <p className="text-xs text-destructive">{recoveryError}</p>}
									<div className="flex gap-2">
										<Button
											type="submit"
											variant="primary"
											size="sm"
											disabled={busy || !recoveryCode.trim()}
										>
											{busy ? t`Unlocking…` : t`Unlock`}
										</Button>
										<Button
											variant="secondary"
											size="sm"
											onClick={() => {
												setShowRecovery(false);
												setRecoveryCode("");
												setRecoveryError(null);
											}}
											disabled={busy}
										>
											<Trans>Cancel</Trans>
										</Button>
									</div>
								</form>
							) : (
								<div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
									{recoveryAvailable && (
										<Button
											variant="link"
											size="none"
											onClick={() => {
												setRecoveryError(null);
												setShowRecovery(true);
											}}
											className="text-xs transition-colors"
										>
											<Trans>Unlock with recovery code</Trans>
										</Button>
									)}
									{recoveryAvailable && showDifferentVault && (
										<span aria-hidden="true" className="text-muted-foreground/50">
											·
										</span>
									)}
									{showDifferentVault && (
										<Button
											variant="link"
											size="none"
											onClick={() => clearSelection()}
											disabled={busy}
											className="text-xs transition-colors"
										>
											<Trans>Choose a different vault</Trans>
										</Button>
									)}
								</div>
							)}
						</div>
					)}

					{/* Exactly one existing vault: a plain divider + "create another". With several
					    vaults, creating another is delegated to the vault picker, so the unlock
					    screen drops this prompt entirely. */}
					{!firstRun && !couldNotRead && !multipleVaults && (
						<div className="mt-6 text-center space-y-3">
							<div className="h-px bg-border/50"></div>

							<Button
								variant="link"
								size="none"
								onClick={handleOpenSetup}
								disabled={busy}
								className="text-sm text-foreground hover:text-primary active:scale-[0.98]"
							>
								<Trans>Create another vault</Trans>
							</Button>
						</div>
					)}

					<div className="mt-6 p-4 rounded-lg border border-border/30 bg-card/30 backdrop-blur-sm">
						<div className="flex items-start gap-3">
							<BrambleGlyph className="w-6 h-6 text-primary shrink-0" />
							<div>
								<h4 className="text-xs mb-1">
									<Trans>Encrypted on your device</Trans>
								</h4>
								<p className="text-xs text-muted-foreground leading-relaxed">
									<Trans>
										Your vault stays on this device, encrypted with AES-256-GCM. Keep your master
										password and recovery code somewhere safe.
									</Trans>
								</p>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
