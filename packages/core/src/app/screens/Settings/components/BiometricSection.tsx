import { useLingui } from "@lingui/react/macro";
import { Fingerprint, LockKeyhole, ScanFace, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { usePrefs } from "../../../../hooks/usePrefs";
import { useVault } from "../../../../hooks/useVault";
import { Row, Toggle } from "./primitives";

/** Settings row to enable/disable this device's biometric unlock. Only rendered on
 * platforms that expose a biometric gate (mobile); the extension has no such capability. */
export function BiometricSection() {
	const {
		biometricSupported,
		biometricAvailable,
		biometricEnabled,
		biometryType,
		enableBiometric,
		disableBiometric,
		refreshBiometric,
	} = useVault();
	const { prefs, update } = usePrefs();
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

	const onToggle = async (next: boolean) => {
		setError(null);
		setBusy(true);
		try {
			if (next) await enableBiometric();
			else await disableBiometric();
		} catch (e) {
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
