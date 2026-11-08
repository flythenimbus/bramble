/// <reference types="chrome" />

import { api } from "../platform-api";
import { type AutofillSessionOwner, autofillSessionOwnerIsCurrent } from "./session";

// The grants behind "Open website": permission to fill one login once in the tab it opened. In
// memory and secret-free, so a worker restart just falls back to the dropdown. The rules that
// spend one are in autofill-index.ts. See docs/launch-and-fill.md.

export const LAUNCH_FILL_TTL_MS = 60_000;
export const LAUNCH_VIEW_GRACE_MS = 15_000;

export type LaunchGrant = Readonly<{
	entryId: string;
	owner: AutofillSessionOwner;
	expiresAt: number;
}>;

const grants = new Map<number, LaunchGrant>();

export function armLaunchGrant(tabId: number, entryId: string, owner: AutofillSessionOwner): void {
	grants.set(tabId, { entryId, owner, expiresAt: Date.now() + LAUNCH_FILL_TTL_MS });
}

/** The tab's grant, dropping one that has expired or outlived its session. */
export function liveLaunchGrant(tabId: number): LaunchGrant | null {
	const grant = grants.get(tabId);
	if (!grant) return null;
	if (Date.now() >= grant.expiresAt || !autofillSessionOwnerIsCurrent(grant.owner)) {
		grants.delete(tabId);
		return null;
	}
	return grant;
}

export function spendLaunchGrant(tabId: number): void {
	grants.delete(tabId);
}

api.tabs.onRemoved?.addListener((tabId) => {
	grants.delete(tabId);
});
