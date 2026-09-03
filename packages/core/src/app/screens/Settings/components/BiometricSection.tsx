import { useLingui } from "@lingui/react/macro";
import { Fingerprint, KeyRound, LockKeyhole, ScanFace, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { useCan } from "../../../../context/PlatformContext";
import { usePrefs } from "../../../../hooks/usePrefs";
import { useVault } from "../../../../hooks/useVault";
import { effectiveAllowPasscode } from "../../../../vault/biometric-unlock";
import { Row, Toggle } from "./primitives";

/** Settings row to enable/disable this device's biometric unlock. Only rendered on
 * platforms that expose a biometric gate (mobile); the extension has no such capability. */
export function BiometricSection() {
	const {
		biometricSupported,
		biometricAvailable,
		biometricEnabled,
		biometryType,
		biometryEnrolled,
		enableBiometric,
		disableBiometric,
		refreshBiometric,
	} = useVault();
	const { prefs, update } = usePrefs();
	const canChoosePasscodeFallback = useCan("biometricPasscodeFallback");
	const { t } = useLingui();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Re-probe on open so a biometric enrolled after launch is picked up here.
	useEffect(() => {
		void refreshBiometric();
	}, [refreshBiometric]);

	if (!biometricSupported) return null;

	// Track the enrolled modality. Android can't tell face from fingerprint, so it
	// reports "biometric" and we keep the generic "Face ID or a fingerprint" copy;
	// iOS reports "passcode" when nothing is enrolled but the gate still opens.
	const isFaceId = biometryType === "faceId" || biometryType === "opticId";
	const Icon = biometryType === "passcode" ? LockKeyhole : isFaceId ? ScanFace : Fingerprint;
	const title =
		biometryType === "faceId"
			? t`Face ID`
			: biometryType === "opticId"
				? t`Optic ID`
				: biometryType === "touchId"
					? t`Touch ID`
					: biometryType === "passcode"
						? t`Device passcode`
						: t`Biometric unlock`;
	// Every sentence below is written out per modality rather than built by dropping a noun into
	// a template. German (and every other case-marking language) declines the noun after a
	// preposition, so an interpolated "your passcode" came out as "mit Ihr Passcode" where it
	// wants "mit Ihrem Passcode" - and a translator handed a fragment cannot fix that.
	// Face ID / Optic ID / Touch ID stay interpolated: they are invariant brand names, so one
	// string covers all three in any language, and only the two real noun phrases need spelling
	// out. Three forms per sentence instead of five.
	const brand =
		biometryType === "opticId"
			? t`Optic ID`
			: biometryType === "touchId"
				? t`Touch ID`
				: t`Face ID`;
	/** Pick the sentence for this device's modality; all three are evaluated so all three extract. */
	const say = (branded: string, passcode: string, generic: string) =>
		biometryType === "passcode" ? passcode : biometryType === "biometric" ? generic : branded;

	// With nothing enrolled there is no biometry-only gate to build, so the passcode is the only
	// thing that can open the cache. That is not a fallback and not a choice, so the row below is
	// hidden entirely rather than shown forced-on: the top row already says "Device passcode".
	const passcodeFallback = effectiveAllowPasscode(
		biometryEnrolled,
		prefs.biometricPasscodeFallback,
	);
	// One gate, one switch. The fallback only means something once a gate is armed AND a biometric
	// exists to fall back FROM, so it follows the row above rather than sitting inert beside it.
	const showPasscodeFallback =
		canChoosePasscodeFallback && biometricAvailable && biometricEnabled && biometryEnrolled;

	const onToggle = async (next: boolean) => {
		setError(null);
		setBusy(true);
		try {
			if (next) await enableBiometric(passcodeFallback);
			else await disableBiometric();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	// The gate's access control is fixed when the VEK is cached, so changing this setting means
	// re-caching it (which also republishes the flag the AutoFill extension labels itself with).
	// Settings is only reachable unlocked, so the VEK is in hand. If the re-arm fails the item
	// still holds the old gate, so put the setting back rather than misreport it.
	const onPasscodeToggle = async (next: boolean) => {
		setError(null);
		setBusy(true);
		try {
			await update("biometricPasscodeFallback", next);
			if (biometricEnabled) await enableBiometric(effectiveAllowPasscode(biometryEnrolled, next));
		} catch (e) {
			await update("biometricPasscodeFallback", !next).catch(() => {});
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	// "Vault" rather than "passwords", matching the master-password and recovery-code rows above.
	// The off state names the master password, because skipping it is what the setting buys; the
	// on state drops it, since by then the only useful thing left to say is what opens the vault.
	const subtitle = !biometricAvailable
		? say(
				t`Set up ${brand} on this device to use this.`,
				t`Set up a passcode on this device to use this.`,
				t`Set up Face ID or a fingerprint on this device to use this.`,
			)
		: biometricEnabled
			? say(
					t`Unlock your vault using ${brand}.`,
					t`Unlock your vault using your passcode.`,
					t`Unlock your vault using Face ID or a fingerprint.`,
				)
			: say(
					t`Unlock your vault using ${brand}, instead of your master password.`,
					t`Unlock your vault using your passcode, instead of your master password.`,
					t`Unlock your vault using Face ID or a fingerprint, instead of your master password.`,
				);

	// The passcode form is unreachable here (the row only renders with a biometric enrolled), but
	// `say` needs all three and an honest sentence beats a placeholder that could one day show.
	const passcodeSubtitle = passcodeFallback
		? t`Your device passcode can also unlock this vault.`
		: say(
				t`Only ${brand} can unlock. Adding or removing a face or fingerprint turns this off, and you'll re-enable it with your master password.`,
				t`Only your passcode can unlock. Adding or removing a face or fingerprint turns this off, and you'll re-enable it with your master password.`,
				t`Only Face ID or a fingerprint can unlock. Adding or removing a face or fingerprint turns this off, and you'll re-enable it with your master password.`,
			);

	return (
		<>
			<Row icon={<Icon className="w-4 h-4 text-primary" />} title={title} subtitle={subtitle}>
				<Toggle
					checked={biometricEnabled && biometricAvailable}
					onChange={(next) => void onToggle(next)}
					label={title}
					disabled={busy || !biometricAvailable}
				/>
			</Row>
			{error && <p className="ml-12 text-xs text-destructive">{error}</p>}
			{/* Sits under the gate it modifies, and only while that gate is on and a biometric is
			    enrolled: anywhere else it is a switch over nothing, which read as two settings
			    contradicting each other. */}
			{showPasscodeFallback && (
				<Row
					icon={<KeyRound className="w-4 h-4 text-primary" />}
					title={t`Allow passcode fallback`}
					subtitle={passcodeSubtitle}
				>
					<Toggle
						checked={passcodeFallback}
						onChange={(next) => void onPasscodeToggle(next)}
						label={t`Toggle passcode fallback`}
						disabled={busy}
					/>
				</Row>
			)}
			{/* Only once the gate is set up: a switch for a prompt that cannot happen is a puzzle. */}
			{biometricAvailable && biometricEnabled && (
				<Row
					icon={<Zap className="w-4 h-4 text-primary" />}
					title={t`Unlock on open`}
					subtitle={say(
						t`Ask for ${brand} as soon as the unlock screen appears, with no tap.`,
						t`Ask for your passcode as soon as the unlock screen appears, with no tap.`,
						t`Ask for Face ID or a fingerprint as soon as the unlock screen appears, with no tap.`,
					)}
				>
					<Toggle
						checked={prefs.biometricAutoPrompt}
						onChange={(next) => void update("biometricAutoPrompt", next)}
						label={t`Toggle unlock on open`}
					/>
				</Row>
			)}
		</>
	);
}
