export type SubdomainMatchMode = "etld1" | "exact" | "subdomain";

export interface MatchSummary {
	id: string;
	name: string;
	username: string;
	// Per-entry autofill opt-out: when false, the content script must not
	// silently single-match auto-fill this entry; the user has to pick it
	// from the dropdown explicitly.
	autofillEnabled?: boolean;
	// When true, the content script submits the form after filling.
	autoSubmit?: boolean;
}

export interface IndexEntry {
	id: string;
	hostname: string;
	name: string;
	username: string;
	password: string;
	// Per-entry overrides (see EntryData in useVault). Optional so older
	// vaults without these fields keep working.
	autofillEnabled?: boolean;
	autoSubmit?: boolean;
	subdomainMatch?: SubdomainMatchMode;
}

export interface Credentials {
	username: string;
	password: string;
	autoSubmit?: boolean;
}

// Returned by `findMatchingEntries`. When the vault is locked, `matches` is
// empty but `hasPotentialMatch` tells the caller whether any entry for this
// hostname exists in the privacy-safe hostname registry — enough info to
// show a "vault is locked, unlock to autofill" hint without exposing data.
export interface FindResult {
	matches: MatchSummary[];
	locked: boolean;
	hasPotentialMatch: boolean;
}

export interface AutofillAdapter {
	// Popup-side: push the unlocked vault's searchable index to the offscreen
	// document so autofill works while the popup is closed. Cleared on lock.
	setIndex(entries: IndexEntry[]): Promise<void>;
	clearIndex(): Promise<void>;

	// Content-script-side: find entries matching a hostname and fetch
	// credentials for filling.
	findMatchingEntries(hostname: string): Promise<FindResult>;
	fetchCredentials(entryId: string): Promise<Credentials>;
}
