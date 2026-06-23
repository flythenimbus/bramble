import { useCallback, useEffect, useState } from "react";
import { usePlatform } from "../context/PlatformContext";

// Preference keys persisted via StorageAdapter.getMeta/setMeta. Mirrored in
// background.ts for the auto-lock + clipboard TTL values the SW reads itself.
export const PREF_AUTOLOCK_MINUTES = "pref.autoLockMinutes";
export const PREF_BREACH_CHECK = "pref.breachCheckEnabled";
export const PREF_CLIPBOARD_SECONDS = "pref.clipboardClearSeconds";
export const PREF_OFFER_TO_SAVE = "pref.offerToSave";
export const PREF_NEVER_SAVE_SITES = "pref.neverSaveSites";
export const PREF_AUTOFILL_KEEP_UNLOCKED = "pref.autofillKeepUnlocked";

export const DEFAULT_AUTOLOCK_MINUTES = 15;
// Off by default: the breach check is the app's only network egress (k-anonymous
// SHA-1 prefix to HIBP), so we don't opt users in silently.
export const DEFAULT_BREACH_CHECK = false;
export const DEFAULT_CLIPBOARD_SECONDS = 30;
export const DEFAULT_OFFER_TO_SAVE = true;
export const DEFAULT_NEVER_SAVE_SITES: string[] = [];
// Off by default: keeping the autofill provider unlocked caches the VEK behind only
// device-unlock for the window, so it is an explicit opt-in (mobile only).
export const DEFAULT_AUTOFILL_KEEP_UNLOCKED = false;

/** Resolved user preferences with their defaults. */
export interface Prefs {
	autoLockMinutes: number;
	breachCheckEnabled: boolean;
	clipboardClearSeconds: number;
	offerToSave: boolean;
	// eTLD+1 hostnames muted via "Never for this site".
	neverSaveSites: string[];
	// Mobile only: keep the OS autofill provider unlocked without re-auth for a window.
	autofillKeepUnlocked: boolean;
}

/** Load and update user preferences via the platform storage adapter. */
export function usePrefs() {
	const { storage } = usePlatform();
	const [prefs, setPrefs] = useState<Prefs>({
		autoLockMinutes: DEFAULT_AUTOLOCK_MINUTES,
		breachCheckEnabled: DEFAULT_BREACH_CHECK,
		clipboardClearSeconds: DEFAULT_CLIPBOARD_SECONDS,
		offerToSave: DEFAULT_OFFER_TO_SAVE,
		neverSaveSites: DEFAULT_NEVER_SAVE_SITES,
		autofillKeepUnlocked: DEFAULT_AUTOFILL_KEEP_UNLOCKED,
	});
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const [a, b, c, d, e, f] = await Promise.all([
				storage.getMeta<number>(PREF_AUTOLOCK_MINUTES),
				storage.getMeta<boolean>(PREF_BREACH_CHECK),
				storage.getMeta<number>(PREF_CLIPBOARD_SECONDS),
				storage.getMeta<boolean>(PREF_OFFER_TO_SAVE),
				storage.getMeta<string[]>(PREF_NEVER_SAVE_SITES),
				storage.getMeta<boolean>(PREF_AUTOFILL_KEEP_UNLOCKED),
			]);
			if (cancelled) return;
			setPrefs({
				autoLockMinutes: typeof a === "number" ? a : DEFAULT_AUTOLOCK_MINUTES,
				breachCheckEnabled: typeof b === "boolean" ? b : DEFAULT_BREACH_CHECK,
				clipboardClearSeconds: typeof c === "number" ? c : DEFAULT_CLIPBOARD_SECONDS,
				offerToSave: typeof d === "boolean" ? d : DEFAULT_OFFER_TO_SAVE,
				neverSaveSites: Array.isArray(e) ? e : DEFAULT_NEVER_SAVE_SITES,
				autofillKeepUnlocked: typeof f === "boolean" ? f : DEFAULT_AUTOFILL_KEEP_UNLOCKED,
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
								: key === "autofillKeepUnlocked"
									? PREF_AUTOFILL_KEEP_UNLOCKED
									: PREF_NEVER_SAVE_SITES;
			await storage.setMeta(metaKey, value);
		},
		[storage],
	);

	return { prefs, loaded, update };
}
