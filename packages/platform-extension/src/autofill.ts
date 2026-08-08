/// <reference types="chrome" />

import type {
	AutofillAdapter,
	FillPayload,
	IndexEntry,
	QueryResult,
} from "@core/adapters/autofill";
import { api } from "./platform-api";

async function send<T = unknown>(type: string, payload?: unknown): Promise<T> {
	const res = await api.runtime.sendMessage({ type, payload });
	if (!res?.ok) throw new Error(res?.error ?? `autofill ${type} failed`);
	return res.data as T;
}

type AutofillSessionCapability = { vaultId: string; token: string };

/** Bind cache mutations to the vault session that initiated them (including lock/unlock ABA). */
function sessionCapability(): Promise<AutofillSessionCapability> {
	return send("AUTOFILL_GET_SESSION_OWNER");
}

function capabilityFromLease(lease: unknown): AutofillSessionCapability {
	if (
		lease &&
		typeof lease === "object" &&
		typeof (lease as AutofillSessionCapability).vaultId === "string" &&
		typeof (lease as AutofillSessionCapability).token === "string"
	) {
		return lease as AutofillSessionCapability;
	}
	throw new Error("invalid autofill index lease");
}

/** AutofillAdapter backed by chrome.runtime messaging to the background worker. */
export const extensionAutofill: AutofillAdapter = {
	beginIndexUpdate: sessionCapability,

	// A missing lease is a caller bug, not a fallback: re-acquiring the capability here would
	// stamp plaintext read under an older session with the CURRENT owner, which is exactly the
	// lock/unlock ABA that beginIndexUpdate exists to catch. Fail loudly instead.
	setIndex: async (entries: IndexEntry[], lease?: unknown) =>
		send("AUTOFILL_SET_INDEX", { entries, owner: capabilityFromLease(lease) }),

	clearIndex: async (lease?: unknown) => {
		const owner = lease === undefined ? await sessionCapability().catch(() => undefined) : lease;
		await send("AUTOFILL_CLEAR_INDEX", owner === undefined ? undefined : { owner });
	},

	query: (hostname, opts) => send<QueryResult>("AUTOFILL_FIND", { hostname, ...opts }),

	fetchFill: (entryId) => send<FillPayload>("AUTOFILL_FETCH", { entryId }),
};
