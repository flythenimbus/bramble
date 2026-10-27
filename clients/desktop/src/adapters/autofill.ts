// Desktop autofill. Filling a browser form goes through the paired extension over the local
// socket; auto-type into native apps is phase 5. Both sit behind this adapter, so nothing in
// @core changes when the second one lands. See docs/desktop-port.md.

import type { AutofillAdapter, FillPayload, QueryResult } from "@core/adapters/autofill";
import { invoke } from "@tauri-apps/api/core";

export const desktopAutofill: AutofillAdapter = {
	// @core already pushes on unlock and clears on lock, which is exactly when the browser
	// link's answers should start and stop being available, so no new plumbing was needed to
	// keep the two in step. The index goes to the Rust side rather than staying in this
	// window: the socket is served there, and a window the user closed must not take the
	// browser link down with it.
	setIndex: (entries) => invoke<void>("link_set_index", { entries }),
	clearIndex: () => invoke<void>("link_clear_index"),

	query: async (): Promise<QueryResult> => ({
		logins: [],
		cards: [],
		otps: [],
		locked: false,
		hasPotentialMatch: false,
	}),

	fetchFill: (): Promise<FillPayload> => {
		throw new Error("Autofill is not wired on desktop yet");
	},
};
