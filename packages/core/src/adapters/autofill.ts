export interface MatchSummary {
	id: string;
	site: string;
	username: string;
}

export interface AutofillAdapter {
	findMatchingEntries(hostname: string): Promise<MatchSummary[]>;
	fillCredentials(entryId: string, tabId: number): Promise<void>;
}
