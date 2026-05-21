import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

const STORAGE_KEY = "vault-theme";

interface ThemeContextValue {
	darkMode: boolean;
	toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [darkMode, setDarkMode] = useState(() => {
		if (typeof window === "undefined") return false;
		return localStorage.getItem(STORAGE_KEY) === "dark";
	});

	useEffect(() => {
		document.documentElement.classList.toggle("dark", darkMode);
		localStorage.setItem(STORAGE_KEY, darkMode ? "dark" : "light");
	}, [darkMode]);

	return (
		<ThemeContext.Provider value={{ darkMode, toggleTheme: () => setDarkMode((m) => !m) }}>
			{children}
		</ThemeContext.Provider>
	);
}

export function useTheme(): ThemeContextValue {
	const ctx = useContext(ThemeContext);
	if (!ctx) throw new Error("useTheme called outside ThemeProvider");
	return ctx;
}
