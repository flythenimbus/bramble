import { Fingerprint } from "lucide-react";
import { useState } from "react";
import { useVault } from "../../../../hooks/useVault";
import { Row, Toggle } from "./primitives";

/** Settings row to enable/disable this device's biometric unlock. Only rendered on
 * platforms that expose a biometric gate (mobile); the extension has no such capability. */
export function BiometricSection() {
	const {
		biometricSupported,
		biometricAvailable,
		biometricEnabled,
		enableBiometric,
		disableBiometric,
	} = useVault();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!biometricSupported) return null;

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
		? "Set up Face ID or a fingerprint on this device to use this."
		: biometricEnabled
			? "This device can unlock with Face ID or a fingerprint."
			: "Skip your password on this device with Face ID or a fingerprint.";

	return (
		<>
			<Row
				icon={<Fingerprint className="w-4 h-4 text-primary" />}
				title="Biometric unlock"
				subtitle={subtitle}
			>
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
