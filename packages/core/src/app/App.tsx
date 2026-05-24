import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { VaultProvider } from "../hooks/useVault";
import { PopOutProvider } from "./hooks/usePopOut";
import { ThemeProvider } from "./hooks/useTheme";
import { createAppRouter } from "./router";

interface AppProps {
	initialPath?: string;
	initialDraft?: unknown;
}

export default function App({ initialPath, initialDraft }: AppProps = {}) {
	// One router per tree, seeded once with the handed-over path.
	const [router] = useState(() => createAppRouter(initialPath));
	return (
		<ThemeProvider>
			<VaultProvider>
				<PopOutProvider router={router} initialDraft={initialDraft}>
					<RouterProvider router={router} />
				</PopOutProvider>
			</VaultProvider>
		</ThemeProvider>
	);
}
