import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useVault, VaultProvider } from "../hooks/useVault";
import { PopOutProvider } from "./hooks/usePopOut";
import { ThemeProvider } from "./hooks/useTheme";
import { type AppRouter, createAppRouter } from "./router";

interface AppProps {
	// Route + form draft handed over from a pop-out; absent for a normal popup.
	initialPath?: string;
	initialDraft?: unknown;
}

// Feeds the live vault slice to route guards via the router context prop. Since
// context changes only affect future navigations, we invalidate() on every slice
// change to re-run active beforeLoad guards (bouncing to unlock on auto-lock, etc).
function InnerApp({ router }: { router: AppRouter }) {
	const { isLocked, ready, entries } = useVault();
	const vault = useMemo(() => ({ isLocked, ready, entries }), [isLocked, ready, entries]);

	// `vault` is the change trigger, not a body input: dropping it would fire
	// invalidate only on mount and defeat the reactive guards.
	// biome-ignore lint/correctness/useExhaustiveDependencies: vault is the change trigger for invalidate
	useEffect(() => {
		void router.invalidate();
	}, [router, vault]);

	return <RouterProvider router={router} context={{ vault }} />;
}

/** Root component: wires theme, vault, pop-out, and router providers around the app. */
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
