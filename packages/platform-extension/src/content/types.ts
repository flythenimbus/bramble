// Shared content-script types. These mirror `@core/adapters/autofill` but are
// duplicated here to keep the content script a flat bundle with no cross-package
// runtime imports.

export interface MatchSummary {
	id: string;
	name: string;
	// Username for a login, masked "•••• 1234" for a card.
	secondary: string;
	autofillEnabled?: boolean;
	autoSubmit?: boolean;
}

export interface CustomFieldData {
	key: string;
	value: string;
}

export interface QueryResult {
	// Logins matching this page's hostname.
	logins: MatchSummary[];
	// Every stored card (offered on any payment form).
	cards: MatchSummary[];
	// Hostname-matched logins with a TOTP key (offered on a one-time-code field).
	otps: MatchSummary[];
	locked: boolean;
	hasPotentialMatch: boolean;
	// The user turned page autofill off: show nothing and stop querying.
	disabled?: boolean;
	// A password shaped by the user's generator settings, for a signup form's suggestion.
	// Absent when the page has no login field, or when an older background didn't send one.
	generated?: string;
}

/** Fill instruction from the background, discriminated by `kind`. `isAuto` echoes whether the fill was user-initiated. */
export type FillPayload =
	| {
			kind: "login";
			username: string;
			password: string;
			// Live one-time code, present when the login has a TOTP key.
			totp?: string;
			customFields?: CustomFieldData[];
			autoSubmit?: boolean;
			isAuto?: boolean;
			// Fill only the page's one-time-code field (the 2FA step), not the
			// username/password.
			otpOnly?: boolean;
	  }
	| {
			kind: "card";
			cardholderName: string;
			number: string;
			expMonth: string;
			expYear: string;
			cvv: string;
			customFields?: CustomFieldData[];
			isAuto?: boolean;
	  };

export type AutofillQueryResponse = { ok: true; data: QueryResult } | { ok: false; error: string };

export type AutofillSelectResponse =
	| {
			ok: true;
			data: {
				payload: FillPayload;
				isAuto: boolean;
				otpOnly: boolean;
				sessionGeneration: number;
			};
	  }
	| { ok: false; error: string };

export type AutofillSubmitRevalidationResponse =
	| { ok: true; data: { sessionGeneration: number } }
	| { ok: false; error: string };

// Mirror of `CornerPromptPayload` in `@core/adapters/autofill`; duplicated to
// keep the content script a flat bundle with no cross-package runtime imports.
export type CornerPromptPayload =
	| {
			kind: "save-login";
			promptId: string;
			hostname: string;
			locked: boolean;
			username: string;
			password: string;
	  }
	| {
			kind: "update-login";
			promptId: string;
			hostname: string;
			locked: boolean;
			candidates: { id: string; name: string; username: string }[];
			newPassword: string;
	  }
	| {
			kind: "save-passkey";
			promptId: string;
			hostname: string;
			locked: boolean;
			intent: "create" | "get";
			rpId: string;
			rpName?: string;
			userName?: string;
			existingLoginName?: string;
			candidates?: { id: string; name: string; username: string }[];
			passkeyChoices?: { credentialId: string; label: string }[];
	  };
