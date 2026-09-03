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
	// Noun phrase woven into the subtitle copy below ("...with Face ID").
	const name =
		biometryType === "faceId"
			? t`Face ID`
			: biometryType === "opticId"
				? t`Optic ID`
				: biometryType === "touchId"
					? t`Touch ID`
					: biometryType === "passcode"
						? t`your device passcode`
						: t`Face ID or a fingerprint`;

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

	const subtitle = !biometricAvailable
		? t`Set up ${name} on this device to use this.`
		: biometricEnabled
			? t`This device can unlock with ${name}.`
			: t`Skip your password on this device with ${name}.`;

	const passcodeSubtitle = passcodeFallback
		? t`Your device passcode can also unlock this vault.`
		: t`Only ${name} can unlock. Adding or removing a face or fingerprint turns this off, and you'll re-enable it with your master password.`;

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
					subtitle={t`Ask for ${name} as soon as the unlock screen appears, with no tap.`}
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
