import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

const STORAGE_KEY = "vault-theme";

export type ThemeMode = "light" | "dark" | "system";

interface ThemeContextValue {
	themeMode: ThemeMode;
	setThemeMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readMode(): ThemeMode {
	if (typeof window === "undefined") return "system";
	const stored = localStorage.getItem(STORAGE_KEY);
	return stored === "light" || stored === "dark" ? stored : "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [themeMode, setThemeModeState] = useState<ThemeMode>(readMode);
	const [systemDark, setSystemDark] = useState(
		() =>
			typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches,
	);

	// Keep "system" live by tracking the OS scheme.
	useEffect(() => {
		const mql = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => setSystemDark(mql.matches);
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, []);

	const darkMode = themeMode === "system" ? systemDark : themeMode === "dark";

	useEffect(() => {
		document.documentElement.classList.toggle("dark", darkMode);
	}, [darkMode]);

	const setThemeMode = (mode: ThemeMode) => {
		setThemeModeState(mode);
		localStorage.setItem(STORAGE_KEY, mode);
	};

	return (
		<ThemeContext.Provider value={{ themeMode, setThemeMode }}>{children}</ThemeContext.Provider>
	);
}

export function useTheme(): ThemeContextValue {
	const ctx = useContext(ThemeContext);
	if (!ctx) throw new Error("useTheme called outside ThemeProvider");
	return ctx;
}
