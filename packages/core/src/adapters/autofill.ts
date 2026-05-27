export type SubdomainMatchMode = "etld1" | "exact" | "subdomain";

export interface CustomFieldData {
	key: string;
	value: string;
}

export interface MatchSummary {
	id: string;
	name: string;
	secondary: string;
	autofillEnabled?: boolean;
	autoSubmit?: boolean;
}

//
export interface LoginIndexEntry {
	type: "login";
	id: string;
	hostnames: string[];
	name: string;
	username: string;
	password: string;
	totp?: string;
	customFields?: CustomFieldData[];
	autofillEnabled?: boolean;
	autoSubmit?: boolean;
	subdomainMatch?: SubdomainMatchMode;
}

export interface CardIndexEntry {
	type: "card";
	id: string;
	name: string;
	brand?: string;
	cardholderName: string;
	number: string;
	expMonth: string;
	expYear: string;
	cvv: string;
	customFields?: CustomFieldData[];
}

export type IndexEntry = LoginIndexEntry | CardIndexEntry;

export interface QueryResult {
	logins: MatchSummary[];
	cards: MatchSummary[];
	otps: MatchSummary[];
	locked: boolean;
	hasPotentialMatch: boolean;
}

export type FillPayload =
	| {
			kind: "login";
			username: string;
			password: string;
			totp?: string;
			customFields?: CustomFieldData[];
			autoSubmit?: boolean;
	  }
	| {
			kind: "card";
			cardholderName: string;
			number: string;
			expMonth: string;
			expYear: string;
			cvv: string;
			customFields?: CustomFieldData[];
	  };

export interface AutofillAdapter {
	setIndex(entries: IndexEntry[]): Promise<void>;
	clearIndex(): Promise<void>;

	query(
		hostname: string,
		opts: { hasLogin: boolean; hasCard: boolean; hasOtp: boolean },
	): Promise<QueryResult>;
	fetchFill(entryId: string): Promise<FillPayload>;
}
