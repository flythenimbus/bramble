import { Download, Info, Lock, Palette } from "lucide-react";
import { usePlatform } from "../../../context/PlatformContext";
import { useVault } from "../../../hooks/useVault";
import { SelectField } from "../../components/ui/select-field";
import { type ThemeMode, useTheme } from "../../hooks/useTheme";
import { BiometricSection } from "./components/BiometricSection";
import { GeneralSection } from "./components/GeneralSection";
import { MasterPasswordSection } from "./components/MasterPasswordSection";
import { Row, Section } from "./components/primitives";
import { RecoveryCodeSection } from "./components/RecoveryCodeSection";
import { SecurityKeysSection } from "./components/SecurityKeysSection";
import { SyncConnectSection } from "./components/SyncConnectSection";

export function Settings() {
	const { themeMode, setThemeMode } = useTheme();
	const { shell } = usePlatform();
	const { entries } = useVault();

	return (
		<main className="max-w-5xl mx-auto px-4 py-5">
			<div className="space-y-4">
				<GeneralSection />

				<Section icon={<Lock className="w-4 h-4 text-primary" />} title="Security">
					<MasterPasswordSection />
					{/* Security keys (WebAuthn) don't work on mobile; biometric unlock takes their slot there. */}
					{shell.supportsSecurityKeys && <SecurityKeysSection />}
					<BiometricSection />
					<RecoveryCodeSection />
				</Section>

				<Section icon={<Palette className="w-4 h-4 text-primary" />} title="Appearance">
					<Row
						icon={<Palette className="w-4 h-4 text-primary" />}
						title="Theme"
						subtitle="Use light, dark, or match your system"
					>
						<div className="w-44">
							<SelectField
								label="Mode"
								value={themeMode}
								onChange={(e) => setThemeMode(e.target.value as ThemeMode)}
							>
								<option value="light">Light</option>
								<option value="dark">Dark</option>
								<option value="system">System</option>
							</SelectField>
						</div>
					</Row>
				</Section>

				<Section icon={<Download className="w-4 h-4 text-primary" />} title="Data">
					<Row
						icon={<Download className="w-4 h-4 text-primary" />}
						title="Import from another manager"
						subtitle="Bring entries in from 1Password, Bitwarden, KeePass or Proton Pass"
					>
						<button
							type="button"
							onClick={() => void shell.openSetup("import")}
							className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all"
						>
							Import
						</button>
					</Row>
				</Section>

				<SyncConnectSection />

				<Section icon={<Info className="w-4 h-4 text-primary" />} title="About">
					<div className="flex items-center justify-between text-sm">
						<span className="text-muted-foreground">Version</span>
						<span>{shell.version}</span>
					</div>
					<div className="flex items-center justify-between text-sm">
						<span className="text-muted-foreground">Total entries</span>
						<span>{entries.length}</span>
					</div>
				</Section>
			</div>
		</main>
	);
}
