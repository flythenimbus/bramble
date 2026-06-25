import { Clock, Keyboard, ShieldCheck, SlidersHorizontal, Timer } from "lucide-react";
import { useEffect, useState } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import { usePrefs } from "../../../../hooks/usePrefs";
import { useVault } from "../../../../hooks/useVault";
import { toAutofillIndex } from "../../../../vault/autofill-index";
import { SelectField } from "../../../components/ui/select-field";
import { Row, Section, Toggle } from "./primitives";

// Auto-lock timeout values: -1 = Immediately, >0 = minutes, 0 = Never. On mobile this
// one setting also drives the autofill provider's keep-unlocked window: Immediately ->
// 0 (require auth every fill), N minutes -> N, Never -> -1 (never expire).
const keepUnlockedWindow = (autoLockMinutes: number) =>
	autoLockMinutes < 0 ? 0 : autoLockMinutes > 0 ? autoLockMinutes : -1;

/** General settings: auto-lock, clipboard clear, breach checks, and save-prompt prefs. */
export function GeneralSection() {
	const { prefs, loaded, update } = usePrefs();
	const { autofill, shell } = usePlatform();
	const { entries } = useVault();

	// On mobile the auto-lock timeout also governs the autofill provider's keep-unlocked
	// window; push it whenever the setting changes. No-op where there's no native provider.
	useEffect(() => {
		if (loaded) void autofill.setKeepUnlocked?.(keepUnlockedWindow(prefs.autoLockMinutes));
	}, [loaded, prefs.autoLockMinutes, autofill]);

	// Inline keyboard suggestions only work on a keyboard that supports them (always on iOS;
	// keyboard-dependent on Android). Hide the toggle where they can't render so we don't
	// surface a dead control. Starts hidden until the capability resolves.
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
		<Section icon={<SlidersHorizontal className="w-4 h-4 text-primary" />} title="General">
			<Row
				icon={<Clock className="w-4 h-4 text-primary" />}
				title="Auto-lock timeout"
				subtitle={
					autofill.setKeepUnlocked
						? "Lock the vault and require autofill auth after inactivity"
						: "Lock vault after inactivity"
				}
			>
				<div className="w-44">
					<SelectField
						label="Timeout"
						value={String(prefs.autoLockMinutes)}
						onChange={(e) => void update("autoLockMinutes", Number(e.target.value))}
					>
						{/* Mobile (native autofill) extreme: lock right away and require auth on
						    every fill. The default on mobile. */}
						{autofill.setKeepUnlocked && <option value="-1">Immediately</option>}
						<option value="5">5 minutes</option>
						<option value="15">15 minutes</option>
						<option value="30">30 minutes</option>
						<option value="60">1 hour</option>
						<option value="0">Never</option>
					</SelectField>
				</div>
			</Row>

			{/* Keyboard suggestions opt-in: only shown where inline suggestions can actually
			    render (always on iOS; on Android only on a keyboard that supports them). Off by
			    default; turning it on surfaces matching logins inline above the keyboard.
			    Re-index immediately so the change takes effect. */}
			{autofill.setKeepUnlocked && inlineAvailable && (
				<Row
					icon={<Keyboard className="w-4 h-4 text-primary" />}
					title="Keyboard suggestions"
					subtitle="Show matching logins above the keyboard for one-tap autofill."
				>
					<Toggle
						checked={prefs.autofillQuickType}
						onChange={(enabled) =>
							void (async () => {
								await update("autofillQuickType", enabled);
								await autofill.setIndex(toAutofillIndex(entries));
							})()
						}
						label="Toggle keyboard suggestions"
					/>
				</Row>
			)}

			<Row
				icon={<Timer className="w-4 h-4 text-primary" />}
				title="Clipboard auto-clear"
				subtitle="Wipe copied passwords after"
			>
				<div className="w-44">
					<SelectField
						label="Clear after"
						value={String(prefs.clipboardClearSeconds)}
						onChange={(e) => void update("clipboardClearSeconds", Number(e.target.value))}
					>
						<option value="30">30 seconds</option>
						<option value="60">1 minute</option>
						<option value="120">2 minutes</option>
						<option value="300">5 minutes</option>
					</SelectField>
				</div>
			</Row>

			{/* Breach check is opt-in and the only network egress, so the subtitle
			    is explicit about what's sent. */}
			<Row
				icon={<ShieldCheck className="w-4 h-4 text-primary" />}
				title="Check passwords for breaches"
				subtitle="Sends a 5-character SHA-1 prefix of each saved password to haveibeenpwned.com (k-anonymity)"
			>
				<Toggle
					checked={prefs.breachCheckEnabled}
					onChange={(enabled) => void update("breachCheckEnabled", enabled)}
					label="Toggle breach checks"
				/>
			</Row>

			{/* Corner-prompt card; only on platforms with a save-capture surface (not mobile). */}
			{shell.supportsSaveCapture && (
				<Row
					icon={<ShieldCheck className="w-4 h-4 text-primary" />}
					title="Offer to save logins"
					subtitle="Show a save / update card in the corner of the page when you sign in with credentials Vault doesn't have."
				>
					<Toggle
						checked={prefs.offerToSave}
						onChange={(enabled) => void update("offerToSave", enabled)}
						label="Toggle offer to save logins"
					/>
				</Row>
			)}

			{shell.supportsSaveCapture && prefs.neverSaveSites.length > 0 && (
				<Row
					icon={<ShieldCheck className="w-4 h-4 text-primary" />}
					title="Sites you've muted"
					subtitle={`No save card on these ${prefs.neverSaveSites.length === 1 ? "site" : "sites"}. Remove to start prompting again.`}
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
								title={`Remove ${host} from never-save list`}
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
