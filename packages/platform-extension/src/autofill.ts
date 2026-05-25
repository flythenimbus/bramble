/// <reference types="chrome" />
import type {
	AutofillAdapter,
	FillPayload,
	IndexEntry,
	QueryResult,
} from "@core/adapters/autofill";

async function send<T = unknown>(type: string, payload?: unknown): Promise<T> {
	const res = await chrome.runtime.sendMessage({ type, payload });
	if (!res?.ok) throw new Error(res?.error ?? `autofill ${type} failed`);
	return res.data as T;
}

export const extensionAutofill: AutofillAdapter = {
	setIndex: (entries: IndexEntry[]) => send("AUTOFILL_SET_INDEX", entries),

	clearIndex: () => send("AUTOFILL_CLEAR_INDEX"),

	query: (hostname, opts) => send<QueryResult>("AUTOFILL_FIND", { hostname, ...opts }),

	fetchFill: (entryId) => send<FillPayload>("AUTOFILL_FETCH", { entryId }),
};
