import { useLingui } from "@lingui/react/macro";
import { Lock } from "lucide-react";
import { useCan } from "../../../../context/PlatformContext";
import { BiometricSection } from "./BiometricSection";
import { MasterPasswordSection } from "./MasterPasswordSection";
import { Section } from "./primitives";
import { RecoveryCodeSection } from "./RecoveryCodeSection";
import { SecurityKeysSection } from "./SecurityKeysSection";

/** Security tab: master password, security keys, biometric unlock, recovery code. */
export function SecuritySection() {
	const canSecurityKeys = useCan("securityKeys");
	const { t } = useLingui();
	return (
		<Section icon={<Lock className="w-4 h-4 text-primary" />} title={t`Security`}>
			<MasterPasswordSection />
			{/* Security keys (WebAuthn) don't work on mobile; biometric unlock takes their slot there. */}
			{canSecurityKeys && <SecurityKeysSection />}
			<BiometricSection />
			<RecoveryCodeSection />
		</Section>
	);
}
