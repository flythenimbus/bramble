import { RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "./hooks/useTheme";
import { router } from "./router";

export default function App() {
	return (
		<ThemeProvider>
			<RouterProvider router={router} />
		</ThemeProvider>
	);
}
