import { Clock, ShieldCheck, SlidersHorizontal, Smartphone, Timer } from "lucide-react";
import { useEffect } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import { usePrefs } from "../../../../hooks/usePrefs";
import { SelectField } from "../../../components/ui/select-field";
import { Row, Section, Toggle } from "./primitives";

const autoLockLabel = (m: number) => (m === 0 ? "Never" : m === 60 ? "1 hour" : `${m} minutes`);
// The keep-unlocked window reuses the auto-lock timeout. The provider gets: 0 = off,
// a positive minute count, or -1 = never expire (when auto-lock is "Never").
const keepUnlockedWindow = (on: boolean, autoLockMinutes: number) =>
	!on ? 0 : autoLockMinutes > 0 ? autoLockMinutes : -1;

/** General settings: auto-lock, clipboard clear, breach checks, and save-prompt prefs. */
export function GeneralSection() {
	const { prefs, loaded, update } = usePrefs();
	const { autofill } = usePlatform();

	// Keep the OS autofill provider's window in sync with the toggle + the auto-lock
	// timeout it reuses (also pushes the initial value once prefs load). No-op where the
	// platform has no native provider.
	useEffect(() => {
		if (loaded) {
			void autofill.setKeepUnlocked?.(
				keepUnlockedWindow(prefs.autofillKeepUnlocked, prefs.autoLockMinutes),
			);
		}
	}, [loaded, prefs.autofillKeepUnlocked, prefs.autoLockMinutes, autofill]);

	// Prefs come from a quick local-storage read; hold the section until it
	// resolves so the selects don't flash their defaults before snapping over.
	if (!loaded) return null;

	return (
		<Section icon={<SlidersHorizontal className="w-4 h-4 text-primary" />} title="General">
			<Row
				icon={<Clock className="w-4 h-4 text-primary" />}
				title="Auto-lock timeout"
				subtitle="Lock vault after inactivity"
			>
				<div className="w-44">
					<SelectField
						label="Timeout"
						value={String(prefs.autoLockMinutes)}
						onChange={(e) => void update("autoLockMinutes", Number(e.target.value))}
					>
						<option value="5">5 minutes</option>
						<option value="15">15 minutes</option>
						<option value="30">30 minutes</option>
						<option value="60">1 hour</option>
						<option value="0">Never</option>
					</SelectField>
				</div>
			</Row>

			{/* Mobile only: shown where there's a native autofill provider. Caches the
			    key behind device-unlock for the window, so it is opt-in and off by default. */}
			{autofill.setKeepUnlocked && (
				<Row
					icon={<Smartphone className="w-4 h-4 text-primary" />}
					title="Keep autofill unlocked"
					subtitle={
						prefs.autoLockMinutes === 0
							? "Reuses your auto-lock timeout, set to Never, so autofill stays unlocked until you lock Bramble. The key stays cached behind your device unlock until then."
							: `Reuses your auto-lock timeout (${autoLockLabel(prefs.autoLockMinutes)}). After you unlock autofill, fills skip the master password for that long; the key stays cached behind your device unlock for the window.`
					}
				>
					<Toggle
						checked={prefs.autofillKeepUnlocked}
						onChange={(enabled) => void update("autofillKeepUnlocked", enabled)}
						label="Toggle keep autofill unlocked"
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
				subtitle="Sends a 5-char SHA-1 prefix of each saved password to haveibeenpwned.com (k-anonymity: the password itself never leaves the device). The only off-device traffic in the app."
			>
				<Toggle
					checked={prefs.breachCheckEnabled}
					onChange={(enabled) => void update("breachCheckEnabled", enabled)}
					label="Toggle breach checks"
				/>
			</Row>

			{/* Offer to save logins drives the corner-prompt card. */}
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

			{prefs.neverSaveSites.length > 0 && (
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
