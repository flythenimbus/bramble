/// <reference types="chrome" />
import type {
	AutofillAdapter,
	Credentials,
	FindResult,
	IndexEntry,
} from "@core/adapters/autofill";

async function send<T = unknown>(type: string, payload?: unknown): Promise<T> {
	const res = await chrome.runtime.sendMessage({ type, payload });
	if (!res?.ok) throw new Error(res?.error ?? `autofill ${type} failed`);
	return res.data as T;
}

export const extensionAutofill: AutofillAdapter = {
	setIndex: (entries: IndexEntry[]) => send("AUTOFILL_SET_INDEX", entries),

	clearIndex: () => send("AUTOFILL_CLEAR_INDEX"),

	findMatchingEntries: (hostname) => send<FindResult>("AUTOFILL_FIND", { hostname }),

	fetchCredentials: (entryId) => send<Credentials>("AUTOFILL_FETCH", { entryId }),
};
