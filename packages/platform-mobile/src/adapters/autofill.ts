import type { AutofillAdapter } from "@core/index";

// System autofill on mobile is a native credential provider (iOS Credential
// Provider Extension / Android AutofillService), out of scope for the walking
// skeleton. The in-app vault works without it; this adapter is inert for now.
export const mobileAutofill: AutofillAdapter = {
	async setIndex() {},
	async clearIndex() {},
	async query() {
		return { logins: [], cards: [], otps: [], locked: true, hasPotentialMatch: false };
	},
	async fetchFill() {
		throw new Error("autofill not implemented in the mobile POC");
	},
};
