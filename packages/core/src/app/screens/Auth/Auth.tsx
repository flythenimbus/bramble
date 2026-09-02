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
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import {
	isBiometricCancel,
	isBiometricInvalidated,
	isBiometricLockout,
} from "../../../adapters/biometric";
import { useCan, usePlatform } from "../../../context/PlatformContext";
import { useCryptoErrorMessage } from "../../../hooks/useCryptoErrorMessage";
import { usePrefs } from "../../../hooks/usePrefs";
import { useVault } from "../../../hooks/useVault";
import { useVaultRegistry } from "../../../hooks/useVaultRegistry";
import { effectiveAllowPasscode, StaleBiometricCacheError } from "../../../vault/biometric-unlock";
import { displayLabel } from "../../../vault/vault-registry";
import { BrambleGlyph } from "../../components/BrambleGlyph";
import { Button } from "../../components/ui/button";
import { PasswordField } from "../../components/ui/password-field";
import { usePopOut } from "../../hooks/usePopOut";
import { shouldAutoPromptBiometric } from "./auto-biometric";

interface FormValues {
	masterPassword: string;
}

// iOS refuses the gate for a beat after the app returns to the foreground, so an unasked
// prompt gets a few tries before giving up (silently - the button is still there).
const AUTO_PROMPT_ATTEMPTS = 4;
const AUTO_PROMPT_RETRY_MS = 400;

/** Vault unlock screen: master password, security key, and recovery-code paths. */
export function Auth() {
	const {
		hasVault,
		lockedByUser,
		unlock,
		hasPasswordSlot,
		hasWebauthnSlot,
		unlockWithWebauthnKey,
		hasRecoveryCode,
		unlockWithRecoveryCode,
		biometricEnabled,
		biometricAvailable,
		biometryType,
		biometryEnrolled,
		unlockWithBiometric,
		rearmBiometric,
		refreshBiometric,
		vaultError,
	} = useVault();
	const { shell } = usePlatform();
	const { prefs } = usePrefs();
	// Clearing the selection returns to the picker (the auth guard redirects to /select).
	const { vaults, activeId, clearSelection } = useVaultRegistry();
	const multipleVaults = vaults.length > 1;
	// The vault this screen is unlocking, named in the top-left (mirrors the unlocked header).
	// Absent on first run, when there's no vault yet.
	const activeIndex = vaults.findIndex((v) => v.id === activeId);
	const vaultLabel =
		activeIndex >= 0 ? displayLabel(vaults[activeIndex]!.label, activeIndex) : null;
	const canWebauthnUnlock = useCan("webauthnUnlock");
	const { popOut, canPopOut } = usePopOut();
	const { t } = useLingui();
	const cryptoError = useCryptoErrorMessage();
	const appName = shell.appName;
	const onPopOut = canPopOut ? popOut : undefined;

	// OS biometry can be turned off while backgrounded; re-probe on foreground so the button
	// reflects it. The same listener publishes visibility for the auto-prompt below.
	const [visible, setVisible] = useState(() => document.visibilityState === "visible");
	// The OS's own "the app is interactive", which the webview cannot see: on iOS the gate is
	// refused for over a second after this screen starts painting. Hosts with no app lifecycle
	// (extension, desktop) have no hook and are always active.
	const [appActive, setAppActive] = useState(() => shell.onAppStateChange === undefined);
	useEffect(() => shell.onAppStateChange?.(setAppActive), [shell]);
	useEffect(() => {
		const onVisible = () => {
			const nowVisible = document.visibilityState === "visible";
			setVisible(nowVisible);
			if (nowVisible) void refreshBiometric();
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

	// The cached VEK's OS gate is fixed when it is written, so bring it back in line with the
	// setting on the way in. One keychain write, never prompts, and it is what converts a device
	// armed by a build that predates the passcode-fallback setting (those always allowed it).
	// Fire-and-forget: this screen unmounts the moment the vault opens, and nothing here is
	// worth blocking or reporting on.
	// Which gate the setting asks for on THIS device: a phone with nothing enrolled in Face ID /
	// Touch ID can only ever use the passcode, whatever the preference says.
	const allowPasscode = effectiveAllowPasscode(biometryEnrolled, prefs.biometricPasscodeFallback);

	const rearm = useCallback(() => {
		void rearmBiometric(allowPasscode).catch(() => {});
	}, [rearmBiometric, allowPasscode]);

	const onSubmit = async ({ masterPassword }: FormValues) => {
		setBusy(true);
		try {
			await unlock(masterPassword);
			rearm();
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

	const handleWebauthnKey = async () => {
		setBusy(true);
		try {
			await unlockWithWebauthnKey();
			rearm();
		} catch (e) {
			// Surface in the same field-error region as a wrong master password.
			setError("masterPassword", { message: cryptoError(e) });
		} finally {
			setBusy(false);
		}
	};

	// Memoized, unlike its siblings: the auto-prompt effect below depends on it.
	// "retry" means the gate never opened and is worth asking again; see the effect.
	const handleBiometric = useCallback(
		async (auto = false): Promise<"done" | "retry"> => {
			setBusy(true);
			try {
				await unlockWithBiometric(allowPasscode);
				rearm();
			} catch (e) {
				// The gate itself is gone (the enrolled set changed under it), so the button is
				// gone with it - say so even when nobody asked, like a stale cache.
				if (isBiometricInvalidated(e)) {
					setError("masterPassword", {
						message: t`Your biometric enrolment changed, so this device's saved key was discarded. Unlock with your master password to set it up again.`,
					});
				} else if (isBiometricLockout(e)) {
					// ...WithBiometrics has no passcode route out of a lockout, so name the way out.
					if (!auto)
						setError("masterPassword", {
							message: t`Too many failed attempts. Unlock your device with its passcode first, or use your master password.`,
						});
					// A user cancel surfaces here too; the password form stays available below.
				} else if (!auto || e instanceof StaleBiometricCacheError) {
					setError("masterPassword", { message: cryptoError(e) });
				} else if (!isBiometricCancel(e)) {
					// Nothing the user asked for should leave an error on screen; they still have
					// the button, which reports properly. A cancel is an answer, but a gate that
					// never opened is not: iOS pulls the prompt for a beat after the app returns
					// to the foreground. Stay busy so the retry does not flicker the label.
					return "retry";
				}
			}
			setBusy(false);
			return "done";
		},
		[unlockWithBiometric, allowPasscode, rearm, setError, cryptoError, t],
	);

	const handleRecovery = async (e: React.SyntheticEvent) => {
		e.preventDefault();
		setRecoveryError(null);
		setBusy(true);
		try {
			await unlockWithRecoveryCode(recoveryCode);
			rearm();
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
	// Hidden where it can't work (mobile): no PRF, so offering it would be a dead end even for
	// a vault synced from a browser with a registered key.
	const webauthnKeyAvailable = hasVault && canWebauthnUnlock && (hasWebauthnSlot || couldNotRead);
	const recoveryAvailable = hasVault && hasRecoveryCode;
	// Device-local biometric is the fast path when set up; the password/security-key/
	// recovery methods stay as the fallback below it.
	const showBiometric = hasVault && biometricEnabled && biometricAvailable;
	// Opt-in fast unlock: present the gate as soon as this screen is up, one attempt per mount
	// (= per lock episode, since the guard bounces here on every lock). docs/auth-and-unlock.md.
	const autoPromptedRef = useRef(false);
	// The retry sequence outlives the effect that starts it: this effect re-runs on nearly every
	// render (handleBiometric is rebuilt whenever Lingui's `t` is), and hanging the loop off its
	// cleanup silently cancelled the retries after the first attempt.
	const mountedRef = useRef(true);
	useEffect(
		() => () => {
			mountedRef.current = false;
		},
		[],
	);
	useEffect(() => {
		const fire = shouldAutoPromptBiometric({
			enabled: prefs.biometricAutoPrompt,
			offered: showBiometric,
			lockedByUser,
			visible,
			appActive,
			attempted: autoPromptedRef.current,
		});
		if (!fire) return;
		// A hidden document is not rendered, so its rAF never runs: this holds the prompt until
		// the app is genuinely painting, even in a webview that never reports hidden. The flag is
		// set where it fires, so a re-render that cancels the frame reschedules.
		let frame = requestAnimationFrame(() => {
			frame = requestAnimationFrame(() => {
				autoPromptedRef.current = true;
				void (async () => {
					// Painting is not the same as being able to present system UI: on iOS the gate
					// is refused for a moment after a resume. Ask again rather than dropping the
					// user on the password form they opted out of.
					for (let i = 0; i < AUTO_PROMPT_ATTEMPTS && mountedRef.current; i++) {
						if ((await handleBiometric(true)) === "done") return;
						await new Promise((r) => setTimeout(r, AUTO_PROMPT_RETRY_MS));
					}
					if (mountedRef.current) setBusy(false); // gave up, silently: the button remains
				})();
			});
		});
		return () => cancelAnimationFrame(frame);
	}, [prefs.biometricAutoPrompt, showBiometric, lockedByUser, visible, appActive, handleBiometric]);
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
									: t`Tap your key to unlock your vault`}
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
								<div className={showPasswordForm || webauthnKeyAvailable ? "p-6 pb-0" : "p-6"}>
									<Button
										variant="primary"
										size="lg"
										fullWidth
										onClick={() => void handleBiometric()}
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
											: webauthnKeyAvailable || showBiometric
												? t`Unlock with master password`
												: t`Unlock Vault`}
									</Button>
								</form>
							)}

							{webauthnKeyAvailable && (
								<div className={showPasswordForm ? "px-6 pb-6 -mt-3" : "p-6"}>
									<Button
										variant={showPasswordForm ? "secondary" : "primary"}
										size="lg"
										fullWidth
										onClick={handleWebauthnKey}
										disabled={busy}
										className="text-sm"
									>
										<KeyRound className="w-4 h-4" />
										{busy ? t`Waiting for your key…` : t`Tap to unlock`}
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
