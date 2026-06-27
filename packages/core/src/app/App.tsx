import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVault, VaultProvider } from "../hooks/useVault";
import { activateLocale, defaultLocale, resolveLocale } from "../i18n";
import { PopOutProvider } from "./hooks/usePopOut";
import { ThemeProvider } from "./hooks/useTheme";
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
}

// Feeds the live vault slice to route guards via the router context prop. Since
// context changes only affect future navigations, we invalidate() on every slice
// change to re-run active beforeLoad guards (bouncing to unlock on auto-lock, etc).
function InnerApp({ router, pendingLogin }: { router: AppRouter; pendingLogin?: PendingLogin }) {
	const { isLocked, ready, entries } = useVault();
	const vault = useMemo(() => ({ isLocked, ready, entries }), [isLocked, ready, entries]);
	const consumed = useRef(false);

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
export default function App({ initialPath, initialDraft, pendingLogin }: AppProps = {}) {
	// One router per tree, seeded once with the handed-over path.
	const [router] = useState(() => createAppRouter(initialPath));
	// Load the catalog for the detected locale before first paint to avoid an
	// English flash; fall back to the source locale, which always renders.
	const [localeReady, setLocaleReady] = useState(i18n.locale === defaultLocale);
	useEffect(() => {
		const locale = resolveLocale(typeof navigator !== "undefined" ? navigator.language : undefined);
		activateLocale(locale)
			.catch(() => activateLocale(defaultLocale))
			.finally(() => setLocaleReady(true));
	}, []);

	if (!localeReady) return null;

	return (
		<I18nProvider i18n={i18n}>
			<ThemeProvider>
				<VaultProvider>
					<PopOutProvider router={router} initialDraft={initialDraft}>
						<InnerApp router={router} pendingLogin={pendingLogin} />
					</PopOutProvider>
				</VaultProvider>
			</ThemeProvider>
		</I18nProvider>
	);
}
