import { Clock, ShieldCheck, SlidersHorizontal, Timer } from "lucide-react";
import { usePrefs } from "../../../../hooks/usePrefs";
import { SelectField } from "../../../components/ui/select-field";
import { Row, Section, Toggle } from "./primitives";

/** General settings: auto-lock, clipboard clear, breach checks, and save-prompt prefs. */
export function GeneralSection() {
	const { prefs, loaded, update } = usePrefs();

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
