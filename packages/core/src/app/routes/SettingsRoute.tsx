import { useNavigate } from "@tanstack/react-router";
import { useTheme } from "../hooks/useTheme";
import { Settings } from "../screens/Settings/Settings";

export function SettingsRoute() {
	const navigate = useNavigate();
	const { darkMode, toggleTheme } = useTheme();
	return (
		<div className="flex-1 overflow-y-auto">
			<Settings
				onBack={() => navigate({ to: "/vault" })}
				darkMode={darkMode}
				onToggleTheme={toggleTheme}
			/>
		</div>
	);
}
