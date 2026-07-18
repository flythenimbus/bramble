import { useLingui } from "@lingui/react/macro";
import {
	Clock,
	Keyboard,
	KeyRound,
	Lock,
	ShieldCheck,
	SlidersHorizontal,
	Timer,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useCan, usePlatform } from "../../../../context/PlatformContext";
import { usePrefs } from "../../../../hooks/usePrefs";
import { useVault } from "../../../../hooks/useVault";
import { useVaultRegistry } from "../../../../hooks/useVaultRegistry";
import { toAutofillIndex } from "../../../../vault/autofill-index";
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
	const hasPasskeyProviderToggle = useCan("passkeyProviderToggle");
	const hasLockOnScreenLock = useCan("lockOnScreenLock");
	const canSaveCapture = useCan("saveCapture");
	const { entries } = useVault();
	const { t } = useLingui();

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

	// Show the toggle wherever the OS supports inline autofill (iOS always; Android 11+). It's not
	// gated on the active keyboard anymore - that hid it until you'd autofilled once and could stay
	// hidden (github #19); an inert toggle beats an undiscoverable one. Starts hidden until resolved.
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
								await update("autofillQuickType", enabled);
								await autofill.setIndex(toAutofillIndex(entries));
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
					<Toggle
						checked={prefs.passkeyProviderEnabled}
						onChange={(enabled) =>
							void (async () => {
								await update("passkeyProviderEnabled", enabled);
								await shell.setPasskeyProviderEnabled?.(enabled);
							})()
						}
						label={t`Toggle Bramble passkey provider`}
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
							<button
								key={host}
								type="button"
								onClick={() =>
									void update(
										"neverSaveSites",
										prefs.neverSaveSites.filter((h) => h !== host),
									)
								}
								className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-md border border-border hover:bg-primary/5 hover:border-primary/50 transition-all"
								title={t`Remove ${host} from never-save list`}
							>
								{host}
								<span aria-hidden>×</span>
							</button>
						))}
					</div>
				</Row>
			)}
		</Section>
	);
}
