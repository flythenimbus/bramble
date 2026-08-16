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
const PREF_BREACH_CHECK = "pref.breachCheckEnabled";
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
const PREF_STATS_COLLAPSED = "pref.statsCollapsed";
// Desktop only: the user waved away the suggestion to start Bramble at login after setting up
// a backup. Someone who leaves the machine on has a perfectly good reason to decline, and a
// suggestion that cannot be silenced is a nag. See BackupSection.
const PREF_AUTOSTART_PROMPT_DISMISSED = "pref.autostartPromptDismissed";

export const DEFAULT_AUTOLOCK_MINUTES = 15;
// Off by default: the breach check is the app's only network egress (k-anonymous
// SHA-1 prefix to HIBP), so we don't opt users in silently.
const DEFAULT_BREACH_CHECK = false;
export const DEFAULT_CLIPBOARD_SECONDS = 30;
export const DEFAULT_OFFER_TO_SAVE = true;
const DEFAULT_NEVER_SAVE_SITES: string[] = [];
const DEFAULT_AUTOFILL_QUICKTYPE = false;
export const DEFAULT_PASSKEY_PROVIDER = false;
export const DEFAULT_LOCK_ON_SCREEN_LOCK = true;
const DEFAULT_STATS_COLLAPSED = false;
const DEFAULT_AUTOSTART_PROMPT_DISMISSED = false;

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
	// Desktop: the backup section's "start at login" suggestion has been declined.
	autostartPromptDismissed: boolean;
}

/** Each pref's storage key. A map rather than a ternary chain: the type makes it exhaustive, so
 * a new pref cannot quietly share another's key the way a fall-through else did. */
const META_KEYS: Record<keyof Prefs, string> = {
	autoLockMinutes: PREF_AUTOLOCK_MINUTES,
	breachCheckEnabled: PREF_BREACH_CHECK,
	clipboardClearSeconds: PREF_CLIPBOARD_SECONDS,
	offerToSave: PREF_OFFER_TO_SAVE,
	neverSaveSites: PREF_NEVER_SAVE_SITES,
	autofillQuickType: PREF_AUTOFILL_QUICKTYPE,
	passkeyProviderEnabled: PREF_PASSKEY_PROVIDER,
	lockOnScreenLock: PREF_LOCK_ON_SCREEN_LOCK,
	statsCollapsed: PREF_STATS_COLLAPSED,
	autostartPromptDismissed: PREF_AUTOSTART_PROMPT_DISMISSED,
};

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
	autostartPromptDismissed: DEFAULT_AUTOSTART_PROMPT_DISMISSED,
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
			const [a, b, c, d, e, f, g, h, i, j] = await Promise.all([
				storage.getMeta<number>(PREF_AUTOLOCK_MINUTES),
				storage.getMeta<boolean>(PREF_BREACH_CHECK),
				storage.getMeta<number>(PREF_CLIPBOARD_SECONDS),
				storage.getMeta<boolean>(PREF_OFFER_TO_SAVE),
				storage.getMeta<string[]>(PREF_NEVER_SAVE_SITES),
				storage.getMeta<boolean>(PREF_AUTOFILL_QUICKTYPE),
				storage.getMeta<boolean>(PREF_PASSKEY_PROVIDER),
				storage.getMeta<boolean>(PREF_LOCK_ON_SCREEN_LOCK),
				storage.getMeta<boolean>(PREF_STATS_COLLAPSED),
				storage.getMeta<boolean>(PREF_AUTOSTART_PROMPT_DISMISSED),
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
				autostartPromptDismissed: typeof j === "boolean" ? j : DEFAULT_AUTOSTART_PROMPT_DISMISSED,
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
			await storage.setMeta(META_KEYS[key], value);
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
