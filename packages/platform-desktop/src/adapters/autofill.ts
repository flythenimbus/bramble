// Phase 0 stub. Desktop has no fill path yet: auto-type into native apps is phase 5, and
// filling a browser form goes through the extension over native messaging in phase 4.
// Both live behind this adapter, so nothing in @core changes when they land.
// See docs/desktop-port.md.

import type { AutofillAdapter, FillPayload, QueryResult } from "@core/adapters/autofill";

export const desktopAutofill: AutofillAdapter = {
	// No out-of-process consumer to push an index to: this window holds the unlocked vault
	// itself. The spotlight window will read it in-process, not through here.
	setIndex: async () => {},
	clearIndex: async () => {},

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
