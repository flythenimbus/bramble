/// <reference types="chrome" />

// Making Bramble the browser's default password manager (#135). Holding the optional `privacy`
// permission is the choice; see docs/default-password-manager.md.

import type { DefaultPasswordManager } from "@core/adapters/shell";
import { api } from "./platform-api";

/** Optional, so installing or updating never asks for it. */
export const PRIVACY = { permissions: ["privacy"] };

/** The promise form both browsers implement; @types/chrome only has the callback one. */
interface BrowserSetting {
	get(details: object): Promise<{ levelOfControl: string; value: boolean }>;
	set(details: { value: boolean }): Promise<unknown>;
	clear(details: object): Promise<unknown>;
}

interface Services {
	passwordSavingEnabled?: BrowserSetting;
	/** Chromium only. */
	autofillCreditCardEnabled?: BrowserSetting;
}

/** Absent without the permission, and in a context created before it was granted. */
const services = (): Services | undefined =>
	(api as unknown as { privacy?: { services?: Services } }).privacy?.services;

/** The settings Bramble takes over. */
function settings(s: Services): BrowserSetting[] {
	return [s.passwordSavingEnabled, s.autofillCreditCardEnabled].filter((x): x is BrowserSetting =>
		Boolean(x),
	);
}

export function ownerOf(details: {
	levelOfControl: string;
	value: boolean;
}): DefaultPasswordManager {
	if (details.levelOfControl === "controlled_by_this_extension" && !details.value) return "bramble";
	if (
		details.levelOfControl === "not_controllable" ||
		details.levelOfControl === "controlled_by_other_extensions"
	) {
		return "locked";
	}
	return "browser";
}

/**
 * Apply the choice where this context can, and report the state.
 *
 * Best-effort per setting: one a policy holds leaves the rest to switch, and the password one
 * then reads as "locked". With the permission but no binding, the choice stands and the next
 * context applies it, so this reports "bramble".
 */
export async function reconcileDefaultPasswordManager(): Promise<DefaultPasswordManager> {
	try {
		if (!(await api.permissions.contains(PRIVACY))) return "browser";
		const s = services();
		if (!s?.passwordSavingEnabled) return "bramble";
		const before = ownerOf(await s.passwordSavingEnabled.get({}));
		if (before !== "browser") return before;
		await Promise.allSettled(settings(s).map((x) => x.set({ value: false })));
		return ownerOf(await s.passwordSavingEnabled.get({}));
	} catch {
		return "browser";
	}
}

/** The request is the first await, so it runs inside the click that asked for it, which Firefox
 * requires. */
export async function setDefaultPasswordManager(bramble: boolean): Promise<DefaultPasswordManager> {
	if (bramble) {
		if (!(await api.permissions.request(PRIVACY))) return "browser";
	} else if (await api.permissions.contains(PRIVACY)) {
		const s = services();
		if (s) await Promise.allSettled(settings(s).map((x) => x.clear({})));
		await api.permissions.remove(PRIVACY);
	}
	return reconcileDefaultPasswordManager();
}
