import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { usePlatform } from "../context/PlatformContext";

// Preference keys persisted via StorageAdapter.getMeta/setMeta. Mirrored in
// background.ts for the auto-lock + clipboard TTL values the SW reads itself.
export const PREF_AUTOLOCK_MINUTES = "pref.autoLockMinutes";
export const PREF_BREACH_CHECK = "pref.breachCheckEnabled";
export const PREF_CLIPBOARD_SECONDS = "pref.clipboardClearSeconds";
export const PREF_OFFER_TO_SAVE = "pref.offerToSave";
export const PREF_NEVER_SAVE_SITES = "pref.neverSaveSites";
// Mobile (iOS) only: populate the OS QuickType bar with usernames+domains so logins
// surface inline in the keyboard. Off by default since it exposes usernames before auth.
export const PREF_AUTOFILL_QUICKTYPE = "pref.autofillQuickType";
// Extension only: act as a WebAuthn passkey provider for other sites. Off by default
// (attaching the proxy intercepts all browser WebAuthn). See docs/passkey-provider.md.
export const PREF_PASSKEY_PROVIDER = "pref.passkeyProviderEnabled";
// Extension only: also lock the vault when the OS screen locks, independent of the timeout.
// On by default (a screen-lock is a reasonable security floor); turned off to stay unlocked
// on a trusted device even under "Never". See issue #6.
export const PREF_LOCK_ON_SCREEN_LOCK = "pref.lockOnScreenLock";
// Home screen: whether the Total / At Risk / Strong stats row is collapsed.
// Persisted so the user's choice sticks across opens.
export const PREF_STATS_COLLAPSED = "pref.statsCollapsed";

export const DEFAULT_AUTOLOCK_MINUTES = 15;
// Off by default: the breach check is the app's only network egress (k-anonymous
// SHA-1 prefix to HIBP), so we don't opt users in silently.
export const DEFAULT_BREACH_CHECK = false;
export const DEFAULT_CLIPBOARD_SECONDS = 30;
export const DEFAULT_OFFER_TO_SAVE = true;
export const DEFAULT_NEVER_SAVE_SITES: string[] = [];
export const DEFAULT_AUTOFILL_QUICKTYPE = false;
export const DEFAULT_PASSKEY_PROVIDER = false;
export const DEFAULT_LOCK_ON_SCREEN_LOCK = true;
export const DEFAULT_STATS_COLLAPSED = false;

/** Resolved user preferences with their defaults. */
export interface Prefs {
	autoLockMinutes: number;
	breachCheckEnabled: boolean;
	clipboardClearSeconds: number;
	offerToSave: boolean;
	// eTLD+1 hostnames muted via "Never for this site".
	neverSaveSites: string[];
	// iOS QuickType: surface usernames inline in the keyboard (exposes them before auth).
	autofillQuickType: boolean;
	// Extension: act as a WebAuthn passkey provider for other sites.
	passkeyProviderEnabled: boolean;
	// Extension: also lock when the OS screen locks, regardless of the timeout.
	lockOnScreenLock: boolean;
	// Home: collapse the Total / At Risk / Strong stats row.
	statsCollapsed: boolean;
}

const DEFAULT_PREFS: Prefs = {
	autoLockMinutes: DEFAULT_AUTOLOCK_MINUTES,
	breachCheckEnabled: DEFAULT_BREACH_CHECK,
	clipboardClearSeconds: DEFAULT_CLIPBOARD_SECONDS,
	offerToSave: DEFAULT_OFFER_TO_SAVE,
	neverSaveSites: DEFAULT_NEVER_SAVE_SITES,
	autofillQuickType: DEFAULT_AUTOFILL_QUICKTYPE,
	passkeyProviderEnabled: DEFAULT_PASSKEY_PROVIDER,
	lockOnScreenLock: DEFAULT_LOCK_ON_SCREEN_LOCK,
	statsCollapsed: DEFAULT_STATS_COLLAPSED,
};

export interface UsePrefs {
	prefs: Prefs;
	loaded: boolean;
	update<K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<void>;
}

const PrefsContext = createContext<UsePrefs | null>(null);

/**
 * Load user preferences once and share them across the tree. Previously usePrefs was a
 * plain hook, so every caller kept its own copy: N loads on mount and a Settings update()
 * never reached the routes holding a stale snapshot. A single provider fixes both.
 */
export function PrefsProvider({ children }: { children: ReactNode }) {
	const { storage } = usePlatform();
	const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const [a, b, c, d, e, f, g, h, i] = await Promise.all([
				storage.getMeta<number>(PREF_AUTOLOCK_MINUTES),
				storage.getMeta<boolean>(PREF_BREACH_CHECK),
				storage.getMeta<number>(PREF_CLIPBOARD_SECONDS),
				storage.getMeta<boolean>(PREF_OFFER_TO_SAVE),
				storage.getMeta<string[]>(PREF_NEVER_SAVE_SITES),
				storage.getMeta<boolean>(PREF_AUTOFILL_QUICKTYPE),
				storage.getMeta<boolean>(PREF_PASSKEY_PROVIDER),
				storage.getMeta<boolean>(PREF_LOCK_ON_SCREEN_LOCK),
				storage.getMeta<boolean>(PREF_STATS_COLLAPSED),
			]);
			if (cancelled) return;
			setPrefs({
				autoLockMinutes: typeof a === "number" ? a : DEFAULT_AUTOLOCK_MINUTES,
				breachCheckEnabled: typeof b === "boolean" ? b : DEFAULT_BREACH_CHECK,
				clipboardClearSeconds: typeof c === "number" ? c : DEFAULT_CLIPBOARD_SECONDS,
				offerToSave: typeof d === "boolean" ? d : DEFAULT_OFFER_TO_SAVE,
				neverSaveSites: Array.isArray(e) ? e : DEFAULT_NEVER_SAVE_SITES,
				autofillQuickType: typeof f === "boolean" ? f : DEFAULT_AUTOFILL_QUICKTYPE,
				passkeyProviderEnabled: typeof g === "boolean" ? g : DEFAULT_PASSKEY_PROVIDER,
				lockOnScreenLock: typeof h === "boolean" ? h : DEFAULT_LOCK_ON_SCREEN_LOCK,
				statsCollapsed: typeof i === "boolean" ? i : DEFAULT_STATS_COLLAPSED,
			});
			setLoaded(true);
		})();
		return () => {
			cancelled = true;
		};
	}, [storage]);

	const update = useCallback(
		async <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
			setPrefs((p) => ({ ...p, [key]: value }));
			const metaKey =
				key === "autoLockMinutes"
					? PREF_AUTOLOCK_MINUTES
					: key === "breachCheckEnabled"
						? PREF_BREACH_CHECK
						: key === "clipboardClearSeconds"
							? PREF_CLIPBOARD_SECONDS
							: key === "offerToSave"
								? PREF_OFFER_TO_SAVE
								: key === "neverSaveSites"
									? PREF_NEVER_SAVE_SITES
									: key === "autofillQuickType"
										? PREF_AUTOFILL_QUICKTYPE
										: key === "passkeyProviderEnabled"
											? PREF_PASSKEY_PROVIDER
											: key === "lockOnScreenLock"
												? PREF_LOCK_ON_SCREEN_LOCK
												: PREF_STATS_COLLAPSED;
			await storage.setMeta(metaKey, value);
		},
		[storage],
	);

	const value = useMemo<UsePrefs>(() => ({ prefs, loaded, update }), [prefs, loaded, update]);

	return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

/** Read shared user preferences. Must be called inside a PrefsProvider. */
export function usePrefs(): UsePrefs {
	const ctx = useContext(PrefsContext);
	if (!ctx) throw new Error("usePrefs called outside PrefsProvider");
	return ctx;
}
