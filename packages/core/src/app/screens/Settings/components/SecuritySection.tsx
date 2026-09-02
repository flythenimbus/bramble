import { useLingui } from "@lingui/react/macro";
import { Lock } from "lucide-react";
import { useWebauthnUnlock } from "../../../hooks/useWebauthnUnlock";
import { BiometricSection } from "./BiometricSection";
import { MasterPasswordSection } from "./MasterPasswordSection";
import { Section } from "./primitives";
import { RecoveryCodeSection } from "./RecoveryCodeSection";
import { TapToUnlockSection } from "./TapToUnlockSection";

/** Security tab: master password, tap to unlock, biometric unlock, recovery code. */
export function SecuritySection() {
	const canWebauthnUnlock = useWebauthnUnlock();
	const { t } = useLingui();
	return (
		<Section icon={<Lock className="w-4 h-4 text-primary" />} title={t`Security`}>
			<MasterPasswordSection />
			{/* Webauthn unlock is extension-only; mobile's biometric cache takes its place there.
			    Firefox shows this but hides the security-key option inside it. */}
			{canWebauthnUnlock && <TapToUnlockSection />}
			<BiometricSection />
			<RecoveryCodeSection />
		</Section>
	);
}
