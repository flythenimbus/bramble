import { App as CapacitorApp } from "@capacitor/app";
import { Device } from "@capacitor/device";
import { SplashScreen } from "@capacitor/splash-screen";
import { PREF_AUTOLOCK_MINUTES } from "@core/hooks/usePrefs";
import {
	App,
	OptionsApp,
	type PendingLogin,
	type Platform,
	PlatformProvider,
	tryAppBack,
} from "@core/index";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@core/styles/index.css";
import "./styles/mobile.css";
import { mobileAutofill } from "./adapters/autofill";
import { mobileBiometric } from "./adapters/biometric";
import { mobileClipboard } from "./adapters/clipboard";
import { mobileCrypto } from "./adapters/crypto";
import { resolveExchange } from "./adapters/exchange";
import { mobileShell, mobileTarget, registerOpenSetup, resolveAppVersion } from "./adapters/shell";
import { mobileStorage } from "./adapters/storage";
import { startAutoLock } from "./auto-lock";
import { consumePendingAutofillSave } from "./autofill-pending";
import { hasPendingImport, onImportAvailable } from "./credential-exchange";
import { installNativeWebRtc } from "./native-webrtc";
import { initRosterSync } from "./sync/sync-manager";

// iOS WKWebView (capacitor:// scheme) has no RTCPeerConnection; install the native-backed
// shim before any sync transport runs. No-op on Android/extension/dev-browser.
installNativeWebRtc();

const platform: Platform = {
	target: mobileTarget,
	storage: mobileStorage,
	crypto: mobileCrypto,
	autofill: mobileAutofill,
	shell: mobileShell,
	clipboard: mobileClipboard,
	biometric: mobileBiometric,
	// iOS only, and presence just means the plugin exists; the UI asks it whether this
	// particular device can actually exchange. Kept off the async boot path on purpose.
	exchange: resolveExchange(),
};

// Single-window host: `App` is the vault/unlock UI; the setup flow (create/open a
// vault) is `OptionsApp`, shown when `shell.openSetup()` fires and dismissed when
// it completes. The WASM crypto + filesystem are process singletons, so remounting
// `App` afterwards reflects the now-unlocked vault.
// Device language tag, resolved once before first render. On iOS WKWebView
// navigator.language is clamped to the app bundle's localizations, so we read the
// real device locale from Capacitor Device and hand it to @core's App.
let deviceLocale: string | undefined;

function Root() {
	// "app" = vault/unlock UI; "setup" = create/open a vault; "import" = import wizard;
	// "restore" = restore a .bramble backup. All but "app" render OptionsApp and dismiss
	// back to "app" on completion/close.
	const [view, setView] = useState<"app" | "setup" | "import" | "restore">("app");
	const [pendingLogin, setPendingLogin] = useState<PendingLogin | null>(null);
	// The back-button listener is registered once; read the current view through a ref.
	const viewRef = useRef(view);
	viewRef.current = view;
	useEffect(
		() =>
			registerOpenSetup((screen) =>
				setView(screen === "import" ? "import" : screen === "restore" ? "restore" : "setup"),
			),
		[],
	);

	// An inbound credential-exchange transfer (iOS 26+): the OS launches us with a token, so
	// route to the import wizard, which owns claiming and redeeming it.
	//
	// Two paths, because one is not enough. The event covers an app that is already running.
	// At a COLD launch the activity is delivered before the webview exists, so that event
	// fires into nothing; the token is parked natively and we ask for it on mount instead.
	// Routing while still locked is deliberate: the import screen shows its own unlock gate
	// and claims the token the moment the vault opens, so the user is never dropped on the
	// vault list having forgotten what they started.
	useEffect(() => onImportAvailable(() => setView("import")), []);
	useEffect(() => {
		void hasPendingImport().then((pending) => {
			if (pending) setView("import");
		});
	}, []);

	// Android hardware / gesture back (github #15): close an open setup/import/restore overlay, else
	// let the app step its (memory-history) router via tryAppBack, else background the app (Android's
	// back-at-root norm). iOS has no hardware back, so backButton never fires there.
	useEffect(() => {
		const sub = CapacitorApp.addListener("backButton", () => {
			if (viewRef.current !== "app") setView("app");
			else if (!tryAppBack()) void CapacitorApp.minimizeApp();
		});
		return () => {
			void sub.then((h) => h.remove());
		};
	}, []);

	// Autofill "save login" handoff: the native AutofillService captures a sign-in, writes
	// it to a file, and launches us. Pick it up on launch and on resume; App opens a
	// prefilled add-login form once the vault is unlocked. No-op on iOS (no file).
	useEffect(() => {
		const check = () => {
			void consumePendingAutofillSave().then((p) => {
				if (p) setPendingLogin(p);
			});
		};
		check();
		const sub = CapacitorApp.addListener("resume", check);
		return () => {
			void sub.then((h) => h.remove());
		};
	}, []);

	// Auto-lock after the configured inactivity timeout (background time counts as
	// inactivity); honors the "Never" setting. onExternalLock then re-locks the UI.
	useEffect(() => startAutoLock(), []);

	// Run ongoing roster sync while unlocked + enrolled (started on unlock).
	useEffect(() => initRosterSync(), []);

	if (view === "app")
		return <App pendingLogin={pendingLogin ?? undefined} preferredLocale={deviceLocale} />;
	return (
		<OptionsApp
			onComplete={() => setView("app")}
			mobile
			screen={view === "import" ? "import" : view === "restore" ? "restore" : undefined}
			preferredLocale={deviceLocale}
		/>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Mobile defaults the auto-lock timeout to "Immediately" (-1) on first run, so the vault
// and autofill both re-lock when you leave the app unless you pick a longer window. Set it
// before the first render so the settings UI and auto-lock read the same value.
void (async () => {
	if ((await mobileStorage.getMeta<number>(PREF_AUTOLOCK_MINUTES)) === undefined) {
		await mobileStorage.setMeta(PREF_AUTOLOCK_MINUTES, -1);
	}
	await resolveAppVersion();
	// Best-effort: detect the device locale before render so the UI loads the right
	// catalog with no English flash. Falls back to navigator.language inside @core.
	deviceLocale = await Device.getLanguageTag()
		.then((r) => r.value)
		.catch(() => undefined);
	createRoot(root).render(
		<PlatformProvider platform={platform}>
			<Root />
		</PlatformProvider>,
	);
	// Hold the native splash (launchAutoHide:false) across the async boot above, then
	// fade it out after the first frame has painted so the app never shows a blank white
	// WebView. No-op in the dev browser. Double-rAF ensures the first render is on screen.
	requestAnimationFrame(() =>
		requestAnimationFrame(() => {
			void SplashScreen.hide({ fadeOutDuration: 200 });
		}),
	);
})();
