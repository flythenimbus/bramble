import type { PasskeyCredential } from "../hooks/useVault";

export type SubdomainMatchMode = "etld1" | "exact" | "subdomain";

/**
 * A custom field's autofillable content. The `key` (the user's field name)
 * drives page-field matching: the content script derives token variants from it.
 */
export interface CustomFieldData {
	/** User's field name, e.g. "Postal code"; matched against page inputs. */
	key: string;
	value: string;
}

/** One row in the autofill dropdown. */
export interface MatchSummary {
	id: string;
	name: string;
	/** Username for a login, or a masked "•••• 1234" for a card. */
	secondary: string;
	/** Login-only opt-out: when false, never silently single-match auto-fill; the user picks from the dropdown. */
	autofillEnabled?: boolean;
	/** Login-only: submit the form after filling. */
	autoSubmit?: boolean;
}

/** A website credential, matched to a page by hostname; the only kind that auto-fills on a single match. */
export interface LoginIndexEntry {
	type: "login";
	id: string;
	/** Hostnames this login is registered against, derived from `LoginEntryData.urls` (empty/unparseable URLs dropped). */
	hostnames: string[];
	name: string;
	username: string;
	password: string;
	/**
	 * Authenticator key (`otpauth://` URI or bare base32 secret) when the login has 2FA.
	 * The live code is computed in the background at fill time; only the digits ever reach the page, never the seed.
	 */
	totp?: string;
	customFields?: CustomFieldData[];
	autofillEnabled?: boolean;
	autoSubmit?: boolean;
	subdomainMatch?: SubdomainMatchMode;
	/**
	 * Passkeys this login holds (provider role). Carried so the native mobile credential
	 * provider can offer + assert them; the extension's passkey provider reads the vault
	 * directly and ignores this. Like `totp`, it includes a secret (the private key) and
	 * rides the same in-memory index the password does.
	 */
	passkeys?: PasskeyCredential[];
}

/** A payment card. Not tied to a hostname: offered on any detected payment form, filled only on explicit pick. */
interface CardIndexEntry {
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

/** Result of a content-script query. Each list is empty when the page has no fields of that kind, or the vault is locked. */
export interface QueryResult {
	/** Hostname-filtered logins. */
	logins: MatchSummary[];
	/** Every stored card (a card isn't tied to a site). */
	cards: MatchSummary[];
	/** Hostname-matched logins carrying a TOTP key, offered when the page has a one-time-code field. */
	otps: MatchSummary[];
	locked: boolean;
	/** Login-only: a known entry exists for this hostname even while locked, enough to show an "unlock to autofill" hint without exposing data. */
	hasPotentialMatch: boolean;
}

/** What to fill for a chosen entry, discriminated by kind. */
export type FillPayload =
	| {
			kind: "login";
			username: string;
			password: string;
			/** Current TOTP code (computed in the background), present only when the login has an authenticator key. */
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

interface CornerPromptCommon {
	/** UUID minted per capture; rides the round-trip on the response so a stale prompt can't commit (id no longer matches the live stash). */
	promptId: string;
	hostname: string;
	/** Background couldn't de-dupe (no autofill index): the card shows "Unlock & save" and responds `save-unlock-first`. */
	locked: boolean;
}

/** In-page prompt to save a credential the user just submitted that we don't have. */
export interface SaveLoginPrompt extends CornerPromptCommon {
	kind: "save-login";
	username: string;
	password: string;
}

/** In-page prompt to update an existing login whose stored password differs from the one just submitted. */
export interface UpdateLoginPrompt extends CornerPromptCommon {
	kind: "update-login";
	/** Existing logins whose stored password differs; more than one shows a radio group so the user picks which to update. */
	candidates: { id: string; name: string; username: string }[];
	newPassword: string;
}

/**
 * In-page prompt to save a passkey the site asked us to create (provider role).
 * Placed like the save-login card, but request-scoped: the WebAuthn create() call is
 * blocking on the user's choice, so the reply rides PASSKEY_PROMPT_RESPONSE (resolving
 * the pending proxy request) rather than the login save stash. See docs/passkey-provider.md.
 */
export interface SavePasskeyPrompt extends CornerPromptCommon {
	kind: "save-passkey";
	/** Whether this is a create (save) or a get (sign-in) confirmation. */
	intent: "create" | "get";
	rpId: string;
	rpName?: string;
	userName?: string;
	/** create only: name of the existing login this passkey will attach to, when one
	 * covers the rpId unambiguously (resolved only when the vault is already unlocked).
	 * Drives "Add a passkey to your existing X login" vs "Save a new passkey" copy. */
	existingLoginName?: string;
	/** create only: when several logins cover the rpId and the account is ambiguous, the
	 * candidates to choose from. The card shows a radio list plus a "Create a new login"
	 * option (last); the reply carries the chosen id (or "new"). */
	candidates?: { id: string; name: string; username: string }[];
	/** get only: when several stored passkeys match the rpId, the ones to choose between.
	 * The card shows a radio list; the reply carries the chosen credentialId. */
	passkeyChoices?: { credentialId: string; label: string }[];
}

export type CornerPromptPayload = SaveLoginPrompt | UpdateLoginPrompt | SavePasskeyPrompt;

/** Reply to a SavePasskeyPrompt; resolves the pending webAuthenticationProxy request. */
export interface PasskeyPromptResponse {
	promptId: string;
	approved: boolean;
	/** create picker: the chosen login id, or "new" to create a fresh login. */
	choice?: string;
}

type CornerPromptResponseAction = "save" | "update" | "dismiss" | "never" | "save-unlock-first";

export interface CornerPromptResponse {
	promptId: string;
	action: CornerPromptResponseAction;
	/** For `update`: which candidate the user chose. */
	chosenEntryId?: string;
	/** For `save` / `save-unlock-first`: the user can edit the username before saving. */
	editedUsername?: string;
}

export interface AutofillAdapter {
	/** Popup-side: push the unlocked vault's searchable index to the background so autofill works while the popup is closed. */
	setIndex(entries: IndexEntry[]): Promise<void>;
	/** Clear the pushed index (on lock). */
	clearIndex(): Promise<void>;
	/**
	 * Mobile only: erase the OS credential provider's stored copy of the vault (the
	 * VEK-encrypted bundle, the password slot, passkeys, and registered identities).
	 * Called on vault DELETE, not on lock: `clearIndex` deliberately leaves the mirror
	 * in place so the provider can still unlock and fill on its own. Without this the
	 * bundle + slot outlive the vault as a self-contained, master-password-openable copy.
	 */
	clearProviderData?(): Promise<void>;
	/**
	 * Mobile only: how long the OS autofill provider may stay unlocked without
	 * re-auth (a "keep unlocked" window, 0 = always require auth). Defined only on
	 * platforms with a native credential provider; absent elsewhere.
	 */
	setKeepUnlocked?(minutes: number): Promise<void>;

	/**
	 * Mobile only: whether the platform can actually render inline keyboard suggestions
	 * (iOS QuickType is always available; on Android it depends on the active keyboard, so
	 * the AOSP keyboard returns false). Settings hides the keyboard-suggestions control when
	 * this resolves false. Absent where there is no native provider.
	 */
	inlineSuggestionsAvailable?(): Promise<boolean>;

	/**
	 * Content-script-side: find matches for a page. `hasLogin`/`hasCard`/`hasOtp`
	 * say which field kinds the page exposes, so only the relevant lists are returned.
	 */
	query(
		hostname: string,
		opts: { hasLogin: boolean; hasCard: boolean; hasOtp: boolean },
	): Promise<QueryResult>;
	/** Resolve the fill payload for a chosen entry. */
	fetchFill(entryId: string): Promise<FillPayload>;
}
