import { useCallback, useEffect, useState } from "react";
import { usePlatform } from "../context/PlatformContext";

// Preference keys persisted via StorageAdapter.getMeta/setMeta. Mirrored in
// background.ts for the auto-lock + clipboard TTL values the SW reads itself.
export const PREF_AUTOLOCK_MINUTES = "pref.autoLockMinutes";
export const PREF_BREACH_CHECK = "pref.breachCheckEnabled";
export const PREF_CLIPBOARD_SECONDS = "pref.clipboardClearSeconds";
export const PREF_OFFER_TO_SAVE = "pref.offerToSave";
export const PREF_NEVER_SAVE_SITES = "pref.neverSaveSites";

export const DEFAULT_AUTOLOCK_MINUTES = 15;
// Off by default: the breach check is the app's only network egress (k-anonymous
// SHA-1 prefix to HIBP), so we don't opt users in silently.
export const DEFAULT_BREACH_CHECK = false;
export const DEFAULT_CLIPBOARD_SECONDS = 30;
export const DEFAULT_OFFER_TO_SAVE = true;
export const DEFAULT_NEVER_SAVE_SITES: string[] = [];

/** Resolved user preferences with their defaults. */
export interface Prefs {
	autoLockMinutes: number;
	breachCheckEnabled: boolean;
	clipboardClearSeconds: number;
	offerToSave: boolean;
	// eTLD+1 hostnames muted via "Never for this site".
	neverSaveSites: string[];
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
	});
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const [a, b, c, d, e] = await Promise.all([
				storage.getMeta<number>(PREF_AUTOLOCK_MINUTES),
				storage.getMeta<boolean>(PREF_BREACH_CHECK),
				storage.getMeta<number>(PREF_CLIPBOARD_SECONDS),
				storage.getMeta<boolean>(PREF_OFFER_TO_SAVE),
				storage.getMeta<string[]>(PREF_NEVER_SAVE_SITES),
			]);
			if (cancelled) return;
			setPrefs({
				autoLockMinutes: typeof a === "number" ? a : DEFAULT_AUTOLOCK_MINUTES,
				breachCheckEnabled: typeof b === "boolean" ? b : DEFAULT_BREACH_CHECK,
				clipboardClearSeconds: typeof c === "number" ? c : DEFAULT_CLIPBOARD_SECONDS,
				offerToSave: typeof d === "boolean" ? d : DEFAULT_OFFER_TO_SAVE,
				neverSaveSites: Array.isArray(e) ? e : DEFAULT_NEVER_SAVE_SITES,
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
								: PREF_NEVER_SAVE_SITES;
			await storage.setMeta(metaKey, value);
		},
		[storage],
	);

	return { prefs, loaded, update };
}
