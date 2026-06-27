import { Fingerprint, ScanFace } from "lucide-react";
import { useEffect, useState } from "react";
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
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Re-probe on open so a biometric enrolled after launch is picked up here.
	useEffect(() => {
		void refreshBiometric();
	}, [refreshBiometric]);

	if (!biometricSupported) return null;

	// Track the enrolled modality. Android can't tell face from fingerprint, so it
	// reports "biometric" and we keep the generic "Face ID or a fingerprint" copy.
	const isFaceId = biometryType === "faceId" || biometryType === "opticId";
	const Icon = isFaceId ? ScanFace : Fingerprint;
	const title =
		biometryType === "faceId"
			? "Face ID"
			: biometryType === "opticId"
				? "Optic ID"
				: biometryType === "touchId"
					? "Touch ID"
					: "Biometric unlock";
	// Noun phrase woven into the subtitle copy below ("...with Face ID").
	const name =
		biometryType === "faceId"
			? "Face ID"
			: biometryType === "opticId"
				? "Optic ID"
				: biometryType === "touchId"
					? "Touch ID"
					: "Face ID or a fingerprint";

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
		? `Set up ${name} on this device to use this.`
		: biometricEnabled
			? `This device can unlock with ${name}.`
			: `Skip your password on this device with ${name}.`;

	return (
		<>
			<Row icon={<Icon className="w-4 h-4 text-primary" />} title={title} subtitle={subtitle}>
				<Toggle
					checked={biometricEnabled}
					onChange={(next) => void onToggle(next)}
					label="Biometric unlock"
					disabled={busy || !biometricAvailable}
				/>
			</Row>
			{error && <p className="ml-12 text-xs text-destructive">{error}</p>}
		</>
	);
}
