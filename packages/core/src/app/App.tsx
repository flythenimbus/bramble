import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePlatform } from "../context/PlatformContext";
import { usePendingPasskeys } from "../hooks/usePendingPasskeys";
import { PrefsProvider } from "../hooks/usePrefs";
import { useVault, VaultProvider } from "../hooks/useVault";
import { ToastProvider } from "./components/ui/toast";
import { ErrorBoundary } from "./ErrorBoundary";
import { PopOutProvider } from "./hooks/usePopOut";
import { ThemeProvider } from "./hooks/useTheme";
import { LocaleGate } from "./LocaleGate";
import { setPendingCreateEntry } from "./pending-create-entry";
import { type AppRouter, createAppRouter } from "./router";

/** A credential the mobile autofill provider captured, to seed a prefilled add-login form. */
export interface PendingLogin {
	host: string;
	username: string;
	password: string;
}

interface AppProps {
	// Route + form draft handed over from a pop-out; absent for a normal popup.
	initialPath?: string;
	initialDraft?: unknown;
	// Mobile only: a captured sign-in to save, surfaced as a prefilled add-login form
	// once the vault is unlocked. Absent on desktop / the extension.
	pendingLogin?: PendingLogin;
	// BCP-47 tag the host detected (mobile reads Capacitor Device.getLanguageTag,
	// which is reliable where WKWebView's navigator.language is clamped to the app
	// bundle's localizations). Falls back to navigator.language.
	preferredLocale?: string;
}

// Feeds the live vault slice to route guards via the router context prop. Since
// context changes only affect future navigations, we invalidate() on every slice
// change to re-run active beforeLoad guards (bouncing to unlock on auto-lock, etc).
function InnerApp({ router, pendingLogin }: { router: AppRouter; pendingLogin?: PendingLogin }) {
	const { isLocked, ready, entries } = useVault();
	const { shell } = usePlatform();
	const vault = useMemo(() => ({ isLocked, ready, entries }), [isLocked, ready, entries]);
	const consumed = useRef(false);

	// Mobile: persist passkeys the native provider minted during a sign-in registration.
	usePendingPasskeys();

	// Stash the current route so a closed-then-reopened popup resumes it (restore in the
	// platform boot, gated on an unlocked session). Skip the detached window (it has its own
	// pop-out handoff) and the "/" unlock/redirect route, so a lock never clobbers the last
	// real route with the unlock screen.
	useEffect(() => {
		if (!shell.persistRoute || shell.isDetached()) return;
		const persist = () => {
			const href = router.state.location.href;
			if (href && href !== "/") shell.persistRoute?.(href);
		};
		persist();
		return router.subscribe("onResolved", persist);
	}, [router, shell]);

	// `vault` is the change trigger, not a body input: dropping it would fire
	// invalidate only on mount and defeat the reactive guards.
	// biome-ignore lint/correctness/useExhaustiveDependencies: vault is the change trigger for invalidate
	useEffect(() => {
		void router.invalidate();
	}, [router, vault]);

	// Autofill save handoff: once the vault is unlocked, seed the create-entry form with
	// the captured credential and route to it. Deferred past unlock so the form actually
	// renders (a locked vault bounces to the unlock screen first).
	useEffect(() => {
		if (!pendingLogin || !ready || isLocked || consumed.current) return;
		consumed.current = true;
		setPendingCreateEntry({
			type: "login",
			name: pendingLogin.host || pendingLogin.username,
			urls: pendingLogin.host ? [pendingLogin.host] : [],
			username: pendingLogin.username,
			password: pendingLogin.password,
		});
		void router.navigate({ to: "/vault/new/$type", params: { type: "login" } });
	}, [pendingLogin, ready, isLocked, router]);

	return <RouterProvider router={router} context={{ vault }} />;
}

/** Root component: wires theme, vault, pop-out, and router providers around the app. */
export default function App({
	initialPath,
	initialDraft,
	pendingLogin,
	preferredLocale,
}: AppProps = {}) {
	// One router per tree, seeded once with the handed-over path.
	const [router] = useState(() => createAppRouter(initialPath));
	return (
		<ErrorBoundary>
			<LocaleGate preferredLocale={preferredLocale}>
				<ThemeProvider>
					<ToastProvider>
						<VaultProvider>
							<PrefsProvider>
								<PopOutProvider router={router} initialDraft={initialDraft}>
									<InnerApp router={router} pendingLogin={pendingLogin} />
								</PopOutProvider>
							</PrefsProvider>
						</VaultProvider>
					</ToastProvider>
				</ThemeProvider>
			</LocaleGate>
		</ErrorBoundary>
	);
}
