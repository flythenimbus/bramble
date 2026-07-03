/// <reference types="chrome" />
import { api } from "../platform-api";

// User preferences, read on demand from chrome.storage.local with defaults.

export const PREF_AUTOLOCK_MINUTES = "pref.autoLockMinutes";
const PREF_CLIPBOARD_SECONDS = "pref.clipboardClearSeconds";
const PREF_OFFER_TO_SAVE = "pref.offerToSave";
const PREF_NEVER_SAVE_SITES = "pref.neverSaveSites";
export const PREF_PASSKEY_PROVIDER = "pref.passkeyProviderEnabled";

const DEFAULT_AUTOLOCK_MINUTES = 15;
const DEFAULT_CLIPBOARD_SECONDS = 30;
const DEFAULT_OFFER_TO_SAVE = true;
// Off by default: attaching the proxy intercepts ALL browser WebAuthn (see webauthn-proxy.ts).
const DEFAULT_PASSKEY_PROVIDER = false;

export async function getAutoLockMinutes(): Promise<number> {
	try {
		const r = await api.storage.local.get(PREF_AUTOLOCK_MINUTES);
		const v = r[PREF_AUTOLOCK_MINUTES];
		if (typeof v === "number" && v >= 0) return v;
	} catch {}
	return DEFAULT_AUTOLOCK_MINUTES;
}

export async function getClipboardSeconds(): Promise<number> {
	try {
		const r = await api.storage.local.get(PREF_CLIPBOARD_SECONDS);
		const v = r[PREF_CLIPBOARD_SECONDS];
		if (typeof v === "number" && v > 0) return v;
	} catch {}
	return DEFAULT_CLIPBOARD_SECONDS;
}

export async function getOfferToSavePref(): Promise<boolean> {
	try {
		const r = await api.storage.local.get(PREF_OFFER_TO_SAVE);
		const v = r[PREF_OFFER_TO_SAVE];
		if (typeof v === "boolean") return v;
	} catch {}
	return DEFAULT_OFFER_TO_SAVE;
}

export async function getPasskeyProviderEnabled(): Promise<boolean> {
	try {
		const r = await api.storage.local.get(PREF_PASSKEY_PROVIDER);
		const v = r[PREF_PASSKEY_PROVIDER];
		if (typeof v === "boolean") return v;
	} catch {}
	return DEFAULT_PASSKEY_PROVIDER;
}

export async function getNeverSaveSites(): Promise<Set<string>> {
	try {
		const r = await api.storage.local.get(PREF_NEVER_SAVE_SITES);
		const v = r[PREF_NEVER_SAVE_SITES];
		if (Array.isArray(v)) return new Set(v.filter((s): s is string => typeof s === "string"));
	} catch {}
	return new Set();
}

export async function appendNeverSaveSite(etld1: string): Promise<void> {
	const current = await getNeverSaveSites();
	if (current.has(etld1)) return;
	current.add(etld1);
	await api.storage.local.set({ [PREF_NEVER_SAVE_SITES]: Array.from(current) });
}
