/// <reference types="chrome" />
import type { AutofillAdapter, MatchSummary } from "@core/adapters/autofill";

async function send<T = unknown>(type: string, payload?: unknown): Promise<T> {
	const res = await chrome.runtime.sendMessage({ type, payload });
	if (!res?.ok) throw new Error(res?.error ?? `autofill ${type} failed`);
	return res.data as T;
}

export const extensionAutofill: AutofillAdapter = {
	findMatchingEntries: (hostname) => send<MatchSummary[]>("AUTOFILL_FIND", { hostname }),
	fillCredentials: (entryId, tabId) => send("AUTOFILL_FILL", { entryId, tabId }),
};
