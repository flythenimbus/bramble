/// <reference types="chrome" />

import { api } from "../platform-api";
import { openUnlockView } from "./popout";
import {
	type AutofillSessionOwner,
	autofillSessionOwner,
	autofillSessionOwnerIsCurrent,
} from "./session";

// The fill shortcut (#215). Only the browser can deliver a command, so pressing it opens the tab it
// was pressed in to one fill, also with "Autofill on web pages" off. In memory and secret-free,
// like the launch grants. The rules that spend one are in autofill-index.ts. See docs/autofill.md.

export const FILL_SHORTCUT_TTL_MS = 30_000;

const grants = new Map<number, { owner: AutofillSessionOwner; expiresAt: number }>();

/** Whether the shortcut was just pressed in this tab, in the session that is still unlocked. */
export function shortcutGrantLive(tabId: number | undefined): boolean {
	if (tabId === undefined) return false;
	const grant = grants.get(tabId);
	if (!grant) return false;
	if (Date.now() >= grant.expiresAt || !autofillSessionOwnerIsCurrent(grant.owner)) {
		grants.delete(tabId);
		return false;
	}
	return true;
}

export function spendShortcutGrant(tabId: number | undefined): void {
	if (tabId !== undefined) grants.delete(tabId);
}

async function fillFromShortcut(tab: chrome.tabs.Tab | undefined): Promise<void> {
	const tabId = tab?.id ?? (await api.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
	if (tabId === undefined) return;
	const owner = autofillSessionOwner();
	if (!owner) {
		await openUnlockView();
		return;
	}
	grants.set(tabId, { owner, expiresAt: Date.now() + FILL_SHORTCUT_TTL_MS });
	// Every frame gets it; the one holding focus answers (content.ts, fillFromShortcut).
	await api.tabs.sendMessage(tabId, { type: "AUTOFILL_SHORTCUT" }).catch(() => {});
}

api.commands?.onCommand.addListener((command, tab) => {
	if (command === "fill-login") void fillFromShortcut(tab);
});

api.tabs.onRemoved?.addListener((tabId) => {
	grants.delete(tabId);
});
