export interface MatchSummary {
	id: string;
	name: string;
	username: string;
}

export interface IndexEntry {
	id: string;
	hostname: string;
	name: string;
	username: string;
	password: string;
}

export interface Credentials {
	username: string;
	password: string;
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
