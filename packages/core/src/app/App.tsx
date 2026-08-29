import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePlatform } from "../context/PlatformContext";
import { usePendingPasskeys } from "../hooks/usePendingPasskeys";
import { PrefsProvider } from "../hooks/usePrefs";
import { useVault, VaultProvider } from "../hooks/useVault";
import { useVaultRegistry, VaultRegistryProvider } from "../hooks/useVaultRegistry";
import { setAppBackHandler } from "./android-back";
import { CornerSavedToast } from "./components/CornerSavedToast";
import { DevFlagsModal, useHydrateDevFlags } from "./components/DevFlagsModal";
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
/** Hydrates persisted overrides, then renders the panel its shortcut opens. */
function DevFlags() {
	useHydrateDevFlags();
	return <DevFlagsModal />;
}

function InnerApp({ router, pendingLogin }: { router: AppRouter; pendingLogin?: PendingLogin }) {
	const { isLocked, ready, entries } = useVault();
	const { ready: registryReady, vaults, activeId } = useVaultRegistry();
	const { shell } = usePlatform();
	const vault = useMemo(() => ({ isLocked, ready, entries }), [isLocked, ready, entries]);
	// Registry slice for the launch-time picker decision.
	const registry = useMemo(
		() => ({ ready: registryReady, count: vaults.length, hasActive: activeId != null }),
		[registryReady, vaults.length, activeId],
	);
	const consumed = useRef(false);

	// Mobile: persist passkeys the native provider minted during a sign-in registration.
	usePendingPasskeys();

	// Stash the current route so a closed-then-reopened popup resumes it (restore in the
	// platform boot, gated on an unlocked session). Skip the "/" unlock/redirect route, so a
	// lock never clobbers the last real route with the unlock screen.
	//
	// The detached window persists too. Its pop-out handoff is a one-shot read consumed at boot,
	// so it covers being opened but not being RELOADED, and a reload is how a window picks up a
	// permission granted during its own lifetime (see docs/desktop-link-optional-permission.md).
	// Without this such a reload silently dumps the user back at the vault list.
	useEffect(() => {
		if (!shell.persistRoute) return;
		const persist = () => {
			const href = router.state.location.href;
			if (href && href !== "/") shell.persistRoute?.(href);
		};
		persist();
		return router.subscribe("onResolved", persist);
	}, [router, shell]);

	// Navigation the host asks for while this window is already open, e.g. the desktop panel
	// opening a highlighted entry. Goes through the router, so the route's own guards still run
	// and a request made while locked lands on the unlock screen.
	useEffect(() => {
		return shell.onNavigateRequest?.((href) => {
			void router.navigate({ href });
		});
	}, [router, shell]);

	// `vault`/`registry` are the change triggers, not body inputs: dropping them would fire
	// invalidate only on mount and defeat the reactive guards.
	// biome-ignore lint/correctness/useExhaustiveDependencies: vault/registry are change triggers for invalidate
	useEffect(() => {
		void router.invalidate();
	}, [router, vault, registry]);

	// Android hardware back (driven by the mobile host's Root listener): step the memory-history
	// router when it can, else report "nowhere to go" so the host minimizes. No-op on the extension.
	useEffect(() => {
		setAppBackHandler(() => {
			if (router.history.canGoBack()) {
				router.history.back();
				return true;
			}
			return false;
		});
		return () => setAppBackHandler(null);
	}, [router]);

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

	return <RouterProvider router={router} context={{ vault, registry }} />;
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
						{/* Mounted here, not in AppLayout: the background commits an "Unlock & save"
						    DURING unlock, before the app chrome renders, so a listener scoped to the
						    unlocked layout would miss the broadcast. */}
						<CornerSavedToast />
						{/* The flag panel and the overrides it persists. Mounted for every host: the
						    shortcut is obscure enough not to be found by accident, and what it flips is
						    UI gating rather than anything standing between a user and their data. */}
						<DevFlags />
						<VaultRegistryProvider>
							<VaultProvider>
								<PrefsProvider>
									<PopOutProvider router={router} initialDraft={initialDraft}>
										<InnerApp router={router} pendingLogin={pendingLogin} />
									</PopOutProvider>
								</PrefsProvider>
							</VaultProvider>
						</VaultRegistryProvider>
					</ToastProvider>
				</ThemeProvider>
			</LocaleGate>
		</ErrorBoundary>
	);
}
