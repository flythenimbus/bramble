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
import { syncKeyFor } from "../sync/sync-keys";
import { useVaultRegistry } from "./useVaultRegistry";

// Preference keys persisted via StorageAdapter.getMeta/setMeta. Mirrored in
// background.ts for the auto-lock + clipboard TTL values the SW reads itself.
export const PREF_AUTOLOCK_MINUTES = "pref.autoLockMinutes";
const PREF_BREACH_CHECK = "pref.breachCheckEnabled";
export const PREF_CLIPBOARD_SECONDS = "pref.clipboardClearSeconds";
export const PREF_OFFER_TO_SAVE = "pref.offerToSave";
// Extension only: the master switch for page autofill. Off hides the in-page dropdown entirely
// (matches, the "Vault locked" row, and the generated-password suggestion) and refuses fills.
export const PREF_AUTOFILL_ENABLED = "pref.autofillEnabled";
export const PREF_NEVER_SAVE_SITES = "pref.neverSaveSites";
// Mobile only: present the biometric gate as soon as the unlock screen is up, rather than
// waiting for a tap. Off by default; see docs/auth-and-unlock.md (issue #43).
export const PREF_BIOMETRIC_AUTO_PROMPT = "pref.biometricAutoPrompt";
// iOS only: let the device passcode open the biometric gate as well as Face ID / Touch ID.
// Off by default, so "Face ID" means Face ID. Changing it re-arms the cached VEK with a
// different Keychain access control; see docs/auth-and-unlock.md.
export const PREF_BIOMETRIC_PASSCODE_FALLBACK = "pref.biometricPasscodeFallback";
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
export const DEFAULT_AUTOFILL_ENABLED = true;
const DEFAULT_NEVER_SAVE_SITES: string[] = [];
const DEFAULT_BIOMETRIC_AUTO_PROMPT = false;
const DEFAULT_BIOMETRIC_PASSCODE_FALLBACK = false;
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
	// Extension: show the in-page autofill dropdown at all.
	autofillEnabled: boolean;
	// eTLD+1 hostnames muted via "Never for this site".
	neverSaveSites: string[];
	// Mobile: fire the biometric prompt when the unlock screen appears, with no tap.
	biometricAutoPrompt: boolean;
	biometricPasscodeFallback: boolean;
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
	autofillEnabled: PREF_AUTOFILL_ENABLED,
	neverSaveSites: PREF_NEVER_SAVE_SITES,
	biometricAutoPrompt: PREF_BIOMETRIC_AUTO_PROMPT,
	biometricPasscodeFallback: PREF_BIOMETRIC_PASSCODE_FALLBACK,
	autofillQuickType: PREF_AUTOFILL_QUICKTYPE,
	passkeyProviderEnabled: PREF_PASSKEY_PROVIDER,
	lockOnScreenLock: PREF_LOCK_ON_SCREEN_LOCK,
	statsCollapsed: PREF_STATS_COLLAPSED,
	autostartPromptDismissed: PREF_AUTOSTART_PROMPT_DISMISSED,
};

/**
 * MUST: no setting may affect a vault other than the one it was set in. See CONTEXT.md.
 *
 * "device" describes the app or the machine and is the same everywhere by intent. "vault"
 * describes ONE vault and is stored at `<key>:<vaultId>`, the convention the sync keys already
 * use (sync-keys.ts, docs/multiple-vaults.md). Anything granting a capability against a vault's
 * data is "vault": the two biometric prefs shipped flat, and a second vault then opened with
 * passcode fallback already on, having never been given it.
 *
 * Exhaustive over `Prefs`, so a new pref cannot be added without deciding - a compile error
 * rather than a silent device-wide default, which is the direction that leaks a permission.
 */
type PrefScope = "device" | "vault";
const PREF_SCOPE: Record<keyof Prefs, PrefScope> = {
	autoLockMinutes: "device",
	breachCheckEnabled: "device",
	clipboardClearSeconds: "device",
	offerToSave: "device",
	autofillEnabled: "device",
	neverSaveSites: "device",
	biometricAutoPrompt: "vault",
	autofillQuickType: "device",
	passkeyProviderEnabled: "device",
	lockOnScreenLock: "device",
	statsCollapsed: "device",
	autostartPromptDismissed: "device",
	biometricPasscodeFallback: "vault",
};

const VAULT_SCOPED = (Object.keys(PREF_SCOPE) as (keyof Prefs)[]).filter(
	(k) => PREF_SCOPE[k] === "vault",
);

/** Their storage keys, for whoever has to clean up after a vault. Pairs with PER_VAULT_SYNC_KEYS. */
export const PER_VAULT_PREF_KEYS = VAULT_SCOPED.map((k) => META_KEYS[k]);

const DEFAULT_PREFS: Prefs = {
	autoLockMinutes: DEFAULT_AUTOLOCK_MINUTES,
	breachCheckEnabled: DEFAULT_BREACH_CHECK,
	clipboardClearSeconds: DEFAULT_CLIPBOARD_SECONDS,
	offerToSave: DEFAULT_OFFER_TO_SAVE,
	autofillEnabled: DEFAULT_AUTOFILL_ENABLED,
	neverSaveSites: DEFAULT_NEVER_SAVE_SITES,
	biometricAutoPrompt: DEFAULT_BIOMETRIC_AUTO_PROMPT,
	biometricPasscodeFallback: DEFAULT_BIOMETRIC_PASSCODE_FALLBACK,
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
/**
 * Read a vault-scoped pref, adopting the value an older build wrote to the flat key.
 *
 * `adopt` is the caller's proof that the flat value belongs to THIS vault - true only when the
 * install has exactly one. With several vaults we cannot know which one set it, and taking it
 * anyway would hand a setting to vaults that never had it, which is the bug the scoping fixed.
 * Multi-vault installs therefore fall back to the default, which is the closed position.
 *
 * The flat key is removed once adopted, so this happens once and a later second vault starts
 * from the default rather than inheriting the first one's answer.
 */
interface PrefStorage {
	getMeta<V>(k: string): Promise<V | undefined>;
	setMeta<V>(k: string, v: V): Promise<void>;
	removeMeta(k: string): Promise<void>;
}

/**
 * Delete the pre-scoping flat values once it is certain they cannot be attributed to a vault.
 *
 * Declining to adopt them is not the same as being rid of them. A flat value left in place is
 * adopted by whichever vault the install is eventually reduced to - delete the others, or delete
 * every vault and create a new one, and that vault silently inherits a gate setting nobody gave
 * it. Since with several vaults the value can never become attributable, retiring it here is what
 * makes non-adoption permanent rather than deferred.
 */
async function retireLegacyFlatPrefs(storage: PrefStorage): Promise<void> {
	await Promise.all(VAULT_SCOPED.map((k) => storage.removeMeta(META_KEYS[k]).catch(() => {})));
}

async function readVaultPref<T>(
	storage: PrefStorage,
	base: string,
	scoped: string,
	adopt: boolean,
): Promise<T | undefined> {
	const current = await storage.getMeta<T>(scoped);
	if (current !== undefined || !adopt || scoped === base) return current;
	const legacy = await storage.getMeta<T>(base);
	if (legacy === undefined) return undefined;
	await storage.setMeta(scoped, legacy);
	await storage.removeMeta(base).catch(() => {});
	return legacy;
}

export function PrefsProvider({ children }: { children: ReactNode }) {
	const { storage } = usePlatform();
	const { activeId, vaults, ready } = useVaultRegistry();
	const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
	const [loaded, setLoaded] = useState(false);
	// Same resolution syncKey uses: the active vault, falling back to the first before one is
	// selected, and unscoped only when there is no vault at all.
	const vaultId = activeId ?? vaults[0]?.id;
	const keyFor = useCallback(
		(pref: keyof Prefs) => {
			const base = META_KEYS[pref];
			return PREF_SCOPE[pref] === "vault" && vaultId ? syncKeyFor(base, vaultId) : base;
		},
		[vaultId],
	);

	useEffect(() => {
		let cancelled = false;
		// Only a single-vault install can prove the old flat value belongs to the vault in hand.
		// Waiting for `ready` matters twice over: an empty registry mid-load would otherwise read
		// as one vault and adopt on behalf of a vault that has not resolved, or read as none and
		// retire a value that was still attributable.
		const adoptLegacy = ready && vaults.length === 1;
		// Several vaults: the value belongs to one of them and we cannot tell which, so it is
		// deleted now rather than left for the last vault standing to inherit. See
		// retireLegacyFlatPrefs.
		const retireLegacy = ready && vaults.length > 1;
		// Drop the previous vault's per-vault values before reading the new one's. Until the read
		// lands the gate settings would otherwise still describe the vault we just left, and
		// Auth turns them straight into the access control it arms. Defaults are the closed
		// position, so the worst a stale window can do now is ask for one tap too many.
		setPrefs((prev) => ({
			...prev,
			...Object.fromEntries(VAULT_SCOPED.map((k) => [k, DEFAULT_PREFS[k]])),
		}));
		void (async () => {
			if (retireLegacy) await retireLegacyFlatPrefs(storage);
			const [a, b, c, d, e, f, g, h, i, j, k, l, m] = await Promise.all([
				storage.getMeta<number>(PREF_AUTOLOCK_MINUTES),
				storage.getMeta<boolean>(PREF_BREACH_CHECK),
				storage.getMeta<number>(PREF_CLIPBOARD_SECONDS),
				storage.getMeta<boolean>(PREF_OFFER_TO_SAVE),
				storage.getMeta<boolean>(PREF_AUTOFILL_ENABLED),
				storage.getMeta<string[]>(PREF_NEVER_SAVE_SITES),
				readVaultPref<boolean>(
					storage,
					PREF_BIOMETRIC_AUTO_PROMPT,
					keyFor("biometricAutoPrompt"),
					adoptLegacy,
				),
				storage.getMeta<boolean>(PREF_AUTOFILL_QUICKTYPE),
				storage.getMeta<boolean>(PREF_PASSKEY_PROVIDER),
				storage.getMeta<boolean>(PREF_LOCK_ON_SCREEN_LOCK),
				storage.getMeta<boolean>(PREF_STATS_COLLAPSED),
				storage.getMeta<boolean>(PREF_AUTOSTART_PROMPT_DISMISSED),
				readVaultPref<boolean>(
					storage,
					PREF_BIOMETRIC_PASSCODE_FALLBACK,
					keyFor("biometricPasscodeFallback"),
					adoptLegacy,
				),
			]);
			if (cancelled) return;
			setPrefs({
				autoLockMinutes: typeof a === "number" ? a : DEFAULT_AUTOLOCK_MINUTES,
				breachCheckEnabled: typeof b === "boolean" ? b : DEFAULT_BREACH_CHECK,
				clipboardClearSeconds: typeof c === "number" ? c : DEFAULT_CLIPBOARD_SECONDS,
				offerToSave: typeof d === "boolean" ? d : DEFAULT_OFFER_TO_SAVE,
				autofillEnabled: typeof e === "boolean" ? e : DEFAULT_AUTOFILL_ENABLED,
				neverSaveSites: Array.isArray(f) ? f : DEFAULT_NEVER_SAVE_SITES,
				biometricAutoPrompt: typeof g === "boolean" ? g : DEFAULT_BIOMETRIC_AUTO_PROMPT,
				autofillQuickType: typeof h === "boolean" ? h : DEFAULT_AUTOFILL_QUICKTYPE,
				passkeyProviderEnabled: typeof i === "boolean" ? i : DEFAULT_PASSKEY_PROVIDER,
				lockOnScreenLock: typeof j === "boolean" ? j : DEFAULT_LOCK_ON_SCREEN_LOCK,
				statsCollapsed: typeof k === "boolean" ? k : DEFAULT_STATS_COLLAPSED,
				autostartPromptDismissed: typeof l === "boolean" ? l : DEFAULT_AUTOSTART_PROMPT_DISMISSED,
				biometricPasscodeFallback: typeof m === "boolean" ? m : DEFAULT_BIOMETRIC_PASSCODE_FALLBACK,
			});
			setLoaded(true);
		})();
		return () => {
			cancelled = true;
		};
		// keyFor changes with the active vault, which is what re-reads the per-vault prefs on a
		// switch. Without it the second vault kept showing the first one's gate settings.
	}, [storage, keyFor, ready, vaults.length]);

	const update = useCallback(
		async <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
			setPrefs((p) => ({ ...p, [key]: value }));
			await storage.setMeta(keyFor(key), value);
		},
		[storage, keyFor],
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
