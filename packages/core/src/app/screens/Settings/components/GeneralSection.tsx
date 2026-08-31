import { useLingui } from "@lingui/react/macro";
import {
	Clock,
	Keyboard,
	KeyRound,
	Lock,
	Power,
	ShieldCheck,
	SlidersHorizontal,
	TextCursorInput,
	Timer,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useCan, usePlatform } from "../../../../context/PlatformContext";
import { useAutostart } from "../../../../hooks/useAutostart";
import { usePrefs } from "../../../../hooks/usePrefs";
import { useVault } from "../../../../hooks/useVault";
import { useVaultRegistry } from "../../../../hooks/useVaultRegistry";
import { toAutofillIndex } from "../../../../vault/autofill-index";
import { Button } from "../../../components/ui/button";
import { SelectField } from "../../../components/ui/select-field";
import { TextField } from "../../../components/ui/text-field";
import { Row, Section, Toggle } from "./primitives";

// Auto-lock timeout values: -1 = Immediate, >0 = minutes, 0 = Never. "Immediate" locks the
// moment the app/UI is no longer in use (mobile: on backgrounding; extension: when the last
// popup/window closes); "Never" holds the vault open until a manual lock or restart. On the
// extension, OS screen-lock is governed separately by the "Lock when the screen locks" toggle
// below (default on), so "Never + toggle off" stays unlocked on a trusted device. On mobile
// this one setting also drives the autofill provider's keep-unlocked window: Immediate -> 0
// (require auth every fill), N minutes -> N, Never -> -1 (never expire).
const keepUnlockedWindow = (autoLockMinutes: number) =>
	autoLockMinutes < 0 ? 0 : autoLockMinutes > 0 ? autoLockMinutes : -1;

/** General settings: auto-lock, clipboard clear, breach checks, and save-prompt prefs. */
export function GeneralSection() {
	const { prefs, loaded, update } = usePrefs();
	const { autofill, shell } = usePlatform();
	const hasAutofillToggle = useCan("autofillToggle");
	const hasPasskeyProviderToggle = useCan("passkeyProviderToggle");
	const hasLockOnScreenLock = useCan("lockOnScreenLock");
	const canSaveCapture = useCan("saveCapture");
	const { entries } = useVault();
	const { t } = useLingui();
	// Turning the passkey provider on can fail in the background (another extension already holds
	// the browser's WebAuthn proxy), so the switch reverts and says why.
	const [passkeyProviderError, setPasskeyProviderError] = useState<string | null>(null);

	// The current vault's name, edited inline. rename() only ever touches the active vault.
	const { vaults, activeId, rename } = useVaultRegistry();
	const currentVault = vaults.find((v) => v.id === activeId);
	const [vaultName, setVaultName] = useState("");
	useEffect(() => {
		setVaultName(currentVault?.label ?? "");
	}, [currentVault?.label]);
	const saveVaultName = () => {
		const next = vaultName.trim();
		if (currentVault && next !== currentVault.label) void rename(next);
	};

	// On mobile the auto-lock timeout also governs the autofill provider's keep-unlocked
	// window; push it whenever the setting changes. No-op where there's no native provider.
	useEffect(() => {
		if (loaded) void autofill.setKeepUnlocked?.(keepUnlockedWindow(prefs.autoLockMinutes));
	}, [loaded, prefs.autoLockMinutes, autofill]);

	// Desktop only; `available` is the adapter's presence rather than a target check, since there
	// is nothing to start on a platform whose host decides when we run.
	const autostart = useAutostart();

	// Shown where the OS supports inline autofill (iOS always; Android 11+). Starts hidden until resolved.
	const [inlineAvailable, setInlineAvailable] = useState(false);
	useEffect(() => {
		let cancelled = false;
		if (!autofill.inlineSuggestionsAvailable) return;
		void autofill.inlineSuggestionsAvailable().then((v) => {
			if (!cancelled) setInlineAvailable(v);
		});
		return () => {
			cancelled = true;
		};
	}, [autofill]);

	// Prefs come from a quick local-storage read; hold the section until it
	// resolves so the selects don't flash their defaults before snapping over.
	if (!loaded) return null;

	return (
		<Section icon={<SlidersHorizontal className="w-4 h-4 text-primary" />} title={t`General`}>
			{currentVault && (
				<TextField
					label={t`Vault name`}
					type="text"
					value={vaultName}
					onChange={(e) => setVaultName(e.target.value)}
					onBlur={saveVaultName}
					autoComplete="off"
				/>
			)}

			<Row
				icon={<Clock className="w-4 h-4 text-primary" />}
				title={t`Auto-lock timeout`}
				subtitle={
					autofill.setKeepUnlocked
						? t`Lock the vault and require autofill auth after inactivity`
						: t`Lock vault after inactivity`
				}
			>
				<div className="w-44">
					<SelectField
						label={t`Timeout`}
						value={String(prefs.autoLockMinutes)}
						onChange={(e) => void update("autoLockMinutes", Number(e.target.value))}
					>
						{/* Most secure: lock the instant the UI is no longer in use. On mobile that's
						    the moment the app is backgrounded (require auth on every fill); on the
						    extension it's when the last popup/window closes. */}
						<option value="-1">{t`Immediate`}</option>
						<option value="5">{t`5 minutes`}</option>
						<option value="15">{t`15 minutes`}</option>
						<option value="30">{t`30 minutes`}</option>
						<option value="60">{t`1 hour`}</option>
						{/* Never auto-lock: hold the vault open until a manual lock or restart.
						    OS screen-lock is governed by the separate toggle below. */}
						<option value="0">{t`Never`}</option>
					</SelectField>
				</div>
			</Row>

			{/* Extension only: lock on OS screen-lock, independent of the timeout. On by default;
			    turning it off is what makes "Never" truly stay unlocked on a trusted device. */}
			{hasLockOnScreenLock && (
				<Row
					icon={<Lock className="w-4 h-4 text-primary" />}
					title={t`Lock when the screen locks`}
					subtitle={t`Also lock the vault whenever your computer's screen locks, whatever the timeout.`}
				>
					<Toggle
						checked={prefs.lockOnScreenLock}
						onChange={(enabled) => void update("lockOnScreenLock", enabled)}
						label={t`Toggle lock when the screen locks`}
					/>
				</Row>
			)}

			{/* Desktop only. Phrased by what it buys rather than by what it does: "start at login"
			    is a chore, "keep backups running" is the reason to accept one. */}
			{autostart.available && (
				<Row
					icon={<Power className="w-4 h-4 text-primary" />}
					title={t`Start Bramble at login`}
					subtitle={t`Runs quietly in the menu bar so scheduled backups happen without you opening the app.`}
				>
					<div className="flex flex-col items-end gap-1">
						<Toggle
							checked={autostart.enabled === true}
							onChange={(on) => void autostart.setEnabled(on)}
							disabled={autostart.enabled === null}
							label={t`Toggle start at login`}
						/>
						{autostart.error && (
							<span className="text-xs text-red-500 text-right">{autostart.error}</span>
						)}
					</div>
				</Row>
			)}

			{/* Keyboard suggestions opt-in: only shown where inline suggestions can actually
			    render (always on iOS; on Android only on a keyboard that supports them). Off by
			    default; turning it on surfaces matching logins inline above the keyboard.
			    Re-index immediately so the change takes effect. */}
			{autofill.setKeepUnlocked && inlineAvailable && (
				<Row
					icon={<Keyboard className="w-4 h-4 text-primary" />}
					title={t`Keyboard suggestions`}
					subtitle={t`Show matching logins above the keyboard for one-tap autofill.`}
				>
					<Toggle
						checked={prefs.autofillQuickType}
						onChange={(enabled) =>
							void (async () => {
								// Lease first: platforms that bind the cache to a vault session reject an
								// unleased re-index rather than stamping it with whatever owner is current.
								const lease = await autofill.beginIndexUpdate?.();
								await update("autofillQuickType", enabled);
								await autofill.setIndex(toAutofillIndex(entries), lease);
							})()
						}
						label={t`Toggle keyboard suggestions`}
					/>
				</Row>
			)}

			<Row
				icon={<Timer className="w-4 h-4 text-primary" />}
				title={t`Clipboard auto-clear`}
				subtitle={t`Wipe copied passwords after`}
			>
				<div className="w-44">
					<SelectField
						label={t`Clear after`}
						value={String(prefs.clipboardClearSeconds)}
						onChange={(e) => void update("clipboardClearSeconds", Number(e.target.value))}
					>
						<option value="30">{t`30 seconds`}</option>
						<option value="60">{t`1 minute`}</option>
						<option value="120">{t`2 minutes`}</option>
						<option value="300">{t`5 minutes`}</option>
					</SelectField>
				</div>
			</Row>

			{/* Breach check is opt-in and the only network egress, so the subtitle
			    is explicit about what's sent. */}
			<Row
				icon={<ShieldCheck className="w-4 h-4 text-primary" />}
				title={t`Check passwords for breaches`}
				subtitle={t`Sends a 5-character SHA-1 prefix of each saved password to haveibeenpwned.com (k-anonymity)`}
			>
				<Toggle
					checked={prefs.breachCheckEnabled}
					onChange={(enabled) => void update("breachCheckEnabled", enabled)}
					label={t`Toggle breach checks`}
				/>
			</Row>

			{/* Passkey provider: extension only (Chromium via webAuthenticationProxy, Firefox via
			    a MAIN-world content-script override). While on, Bramble handles passkey prompts,
			    so the subtitle is explicit. Toggling applies live and persists for next startup. */}
			{hasPasskeyProviderToggle && (
				<Row
					icon={<KeyRound className="w-4 h-4 text-primary" />}
					title={t`Use Bramble for passkeys`}
					subtitle={t`Create and store passkeys for other sites. While on, Bramble handles all passkey prompts in this browser.`}
				>
					<div className="flex flex-col items-end gap-1">
						<Toggle
							checked={prefs.passkeyProviderEnabled}
							onChange={(enabled) =>
								void (async () => {
									setPasskeyProviderError(null);
									await update("passkeyProviderEnabled", enabled);
									try {
										await shell.setPasskeyProviderEnabled?.(enabled);
									} catch (e) {
										// The pref is persisted first, so put it back: leaving it on would attach
										// on the next startup without the user having asked again.
										await update("passkeyProviderEnabled", !enabled);
										setPasskeyProviderError(e instanceof Error ? e.message : String(e));
									}
								})()
							}
							label={t`Toggle Bramble passkey provider`}
						/>
						{passkeyProviderError && (
							<span className="text-xs text-red-500 text-right">{passkeyProviderError}</span>
						)}
					</div>
				</Row>
			)}

			{/* Master switch for the in-page dropdown; extension only. The background reads the pref
			    on every query, so persisting it is what enforces it; setAutofillEnabled only pushes
			    the change to tabs that already have a dropdown open. */}
			{hasAutofillToggle && (
				<Row
					icon={<TextCursorInput className="w-4 h-4 text-primary" />}
					title={t`Autofill on web pages`}
					subtitle={t`Offer saved logins, cards, and generated passwords in a dropdown on the page. When off, copy from the vault instead.`}
				>
					<Toggle
						checked={prefs.autofillEnabled}
						onChange={(enabled) =>
							void (async () => {
								await update("autofillEnabled", enabled);
								await shell.setAutofillEnabled?.(enabled);
							})()
						}
						label={t`Toggle autofill on web pages`}
					/>
				</Row>
			)}

			{/* Corner-prompt card; only on platforms with a save-capture surface (not mobile). */}
			{canSaveCapture && (
				<Row
					icon={<ShieldCheck className="w-4 h-4 text-primary" />}
					title={t`Offer to save logins`}
					subtitle={t`Show a save / update card in the corner of the page when you sign in with credentials Vault doesn't have.`}
				>
					<Toggle
						checked={prefs.offerToSave}
						onChange={(enabled) => void update("offerToSave", enabled)}
						label={t`Toggle offer to save logins`}
					/>
				</Row>
			)}

			{canSaveCapture && prefs.neverSaveSites.length > 0 && (
				<Row
					icon={<ShieldCheck className="w-4 h-4 text-primary" />}
					title={t`Sites you've muted`}
					subtitle={
						prefs.neverSaveSites.length === 1
							? t`No save card on this site. Remove to start prompting again.`
							: t`No save card on these sites. Remove to start prompting again.`
					}
				>
					<div className="flex flex-wrap gap-1.5 justify-end max-w-[12rem]">
						{prefs.neverSaveSites.map((host) => (
							<Button
								key={host}
								variant="secondary"
								size="none"
								onClick={() =>
									void update(
										"neverSaveSites",
										prefs.neverSaveSites.filter((h) => h !== host),
									)
								}
								className="gap-1 px-2 py-0.5 text-[11px] rounded-md"
								title={t`Remove ${host} from never-save list`}
							>
								{host}
								<span aria-hidden>×</span>
							</Button>
						))}
					</div>
				</Row>
			)}
		</Section>
	);
}
