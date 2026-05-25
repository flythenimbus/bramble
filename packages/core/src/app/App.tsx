import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useVault, VaultProvider } from "../hooks/useVault";
import { PopOutProvider } from "./hooks/usePopOut";
import { ThemeProvider } from "./hooks/useTheme";
import { type AppRouter, createAppRouter } from "./router";

interface AppProps {
	initialPath?: string;
	initialDraft?: unknown;
}

function InnerApp({ router }: { router: AppRouter }) {
	const { isLocked, ready, entries } = useVault();
	const vault = useMemo(() => ({ isLocked, ready, entries }), [isLocked, ready, entries]);

	// invalidate only on mount and defeat the reactive guards.
	// biome-ignore lint/correctness/useExhaustiveDependencies: vault is the change trigger for invalidate
	useEffect(() => {
		void router.invalidate();
	}, [router, vault]);

	return <RouterProvider router={router} context={{ vault }} />;
}

export default function App({ initialPath, initialDraft }: AppProps = {}) {
	// One router per tree, seeded once with the handed-over path.
	const [router] = useState(() => createAppRouter(initialPath));
	return (
		<ThemeProvider>
			<VaultProvider>
				<PopOutProvider router={router} initialDraft={initialDraft}>
					<InnerApp router={router} />
				</PopOutProvider>
			</VaultProvider>
		</ThemeProvider>
	);
}
