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

//
//

export type CornerPromptKind = "save-login" | "update-login";

interface CornerPromptCommon {
	promptId: string;
	hostname: string;
	locked: boolean;
}

export interface SaveLoginPrompt extends CornerPromptCommon {
	kind: "save-login";
	username: string;
	password: string;
}

export interface UpdateLoginPrompt extends CornerPromptCommon {
	kind: "update-login";
	candidates: { id: string; name: string; username: string }[];
	newPassword: string;
}

export type CornerPromptPayload = SaveLoginPrompt | UpdateLoginPrompt;

export type CornerPromptResponseAction =
	| "save"
	| "update"
	| "dismiss"
	| "never"
	| "save-unlock-first";

export interface CornerPromptResponse {
	promptId: string;
	action: CornerPromptResponseAction;
	chosenEntryId?: string;
	editedUsername?: string;
}

export interface AutofillAdapter {
	setIndex(entries: IndexEntry[]): Promise<void>;
	clearIndex(): Promise<void>;

	query(
		hostname: string,
		opts: { hasLogin: boolean; hasCard: boolean; hasOtp: boolean },
	): Promise<QueryResult>;
	fetchFill(entryId: string): Promise<FillPayload>;
}
