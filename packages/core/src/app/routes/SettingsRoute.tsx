import { usePlatform } from "../../context/PlatformContext";
import { usePrefs } from "../../hooks/usePrefs";
import { useVault } from "../../hooks/useVault";
import { useTheme } from "../hooks/useTheme";
import { Settings } from "../screens/Settings/Settings";

export function SettingsRoute() {
	const { darkMode, toggleTheme } = useTheme();
	const { prefs, loaded, update } = usePrefs();
	const { entries, lock, verifyMasterPassword, changeMasterPassword } = useVault();
	const { shell } = usePlatform();

	if (!loaded) return null;

	return (
		<div className="flex-1 overflow-y-auto">
			<Settings
				darkMode={darkMode}
				onToggleTheme={toggleTheme}
				autoLockMinutes={prefs.autoLockMinutes}
				clipboardClearSeconds={prefs.clipboardClearSeconds}
				breachCheckEnabled={prefs.breachCheckEnabled}
				totalEntries={entries.length}
				version={shell.version}
				onChangeAutoLock={(minutes) => void update("autoLockMinutes", minutes)}
				onChangeClipboardSeconds={(seconds) => void update("clipboardClearSeconds", seconds)}
				onToggleBreachCheck={(enabled) => void update("breachCheckEnabled", enabled)}
				onLockNow={lock}
				onVerifyCurrentPassword={verifyMasterPassword}
				onChangeMasterPassword={changeMasterPassword}
				onImport={() => void shell.openSetup("import")}
			/>
		</div>
	);
}
