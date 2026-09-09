import { createContext, useContext } from "react";
import type { SyncedSettings } from "../sync";

/**
 * The seam between the vault (which owns the synced settings map) and `usePrefs` (which routes
 * reads and writes to it for any pref scoped `"synced"`).
 *
 * Its own module on purpose. `useVault` already imports a constant from `usePrefs`, so having
 * `usePrefs` import `useVault` back would make a real module cycle between two of the app's most
 * central files. Both import this instead, and it imports neither.
 *
 * See docs/synced-settings.md.
 */
export interface SyncedSettingsAccess {
	/**
	 * The vault's settings map, or undefined when there is none to read: a locked vault, a vault
	 * still loading, or one that has never had a synced setting written. Callers cannot tell
	 * those apart and should not try; `ready` says whether a write would land.
	 */
	settings: SyncedSettings | undefined;
	/** Whether the vault is open, so a read is meaningful and a write can be persisted. */
	ready: boolean;
	/** Write one setting, stamped from this device's clock. `null` clears it. */
	set(key: string, value: unknown | null): Promise<void>;
}

const NOT_READY: SyncedSettingsAccess = {
	settings: undefined,
	ready: false,
	// Silently ignoring the write would be worse: the setting would appear to save and then
	// vanish. A caller that can write is one that checked `ready`.
	set: async () => {
		throw new Error("synced settings are unavailable while the vault is locked");
	},
};

export const SyncedSettingsContext = createContext<SyncedSettingsAccess>(NOT_READY);

/**
 * Read the vault's synced settings.
 *
 * Falls back to a not-ready value rather than throwing when used outside the provider, because
 * `usePrefs` is mounted in tests and hosts that have no vault at all, and a device-scoped pref
 * should not stop working just because nothing supplies this.
 */
export function useSyncedSettings(): SyncedSettingsAccess {
	return useContext(SyncedSettingsContext);
}
