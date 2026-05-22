import { RouterProvider } from "@tanstack/react-router";
import { VaultProvider } from "../hooks/useVault";
import { ThemeProvider } from "./hooks/useTheme";
import { router } from "./router";

export default function App() {
	return (
		<ThemeProvider>
			<VaultProvider>
				<RouterProvider router={router} />
			</VaultProvider>
		</ThemeProvider>
	);
}
