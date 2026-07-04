import { html } from "../template";

// Right chevron (lucide chevron-right): each row is click-to-act, so it cues "pick me".
const chevron = `<svg class="tp-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;

/** Two initials for the avatar: first letters of the first two words, else the first two
 *  characters. Splits on spaces and the usual username separators. */
function initialsOf(label: string): string {
	const parts = label
		.trim()
		.split(/[\s._@+-]+/)
		.filter(Boolean);
	const two =
		parts.length >= 2
			? (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")
			: (parts[0] ?? label).slice(0, 2);
	return two.toUpperCase() || "?";
}

/** One account row. The whole row is a button: clicking it picks that account and acts
 *  immediately (sign in / attach), so there are no separate confirm buttons. `value` is the
 *  credentialId (get) or the login id / "new" (create); the content script reads it as `choice`. */
function choiceRow(value: string, primary: string, sub: string | undefined) {
	return html`<button type="button" class="tp-choice" data-tp-action="passkey-pick" data-tp-value="${value}">
		<span class="tp-avatar">${initialsOf(primary)}</span>
		<span class="tp-choice-text">
			<span class="tp-choice-primary">${primary}</span>
			${sub ? [html`<span class="tp-choice-sub">${sub}</span>`] : []}
		</span>
		${[chevron]}
	</button>`;
}

/** The passkey provider corner card: pick which account to sign in with / attach a new
 * passkey to (each row acts on click), or confirm a single save. Every stored passkey is
 * shown with an avatar + its account name so the user knows exactly who they're acting as. */
export function savePasskeyBody({
	rpId,
	rpName,
	userName,
	intent,
	existingLoginName,
	candidates,
	passkeyChoices,
	primaryLabel,
	locked,
}: {
	rpId: string;
	rpName?: string;
	userName?: string;
	intent: "create" | "get";
	existingLoginName?: string;
	candidates?: { id: string; name: string; username: string }[];
	passkeyChoices?: { credentialId: string; label: string }[];
	primaryLabel: string;
	locked?: boolean;
}) {
	// Avoid "x (x)" when the RP's display name equals its id.
	const site = rpName && rpName !== rpId ? `${rpName} (${rpId})` : rpId;
	const isCreatePicker = intent === "create" && !!candidates && candidates.length > 0;
	const isGetList = intent === "get" && !!passkeyChoices && passkeyChoices.length > 0;
	const hasList = isGetList || isCreatePicker;
	const title = isGetList
		? passkeyChoices.length > 1
			? "Sign in with which passkey?"
			: "Use your passkey?"
		: isCreatePicker
			? "Add this passkey to…"
			: intent === "get"
				? "Use your passkey?"
				: existingLoginName
					? "Add a passkey?"
					: "Save a passkey?";

	// Nested html escapes interpolated values; array interpolations join markup verbatim.
	let middle: string[] = [];
	if (locked) {
		// Locked: the vault can't be read yet, so say what unlocking is for before the popup.
		const note =
			intent === "get"
				? "Unlock Bramble to use your passkeys for this site."
				: "Unlock Bramble to save a passkey for this site.";
		middle = [html`<div class="tp-note">${note}</div>`];
	} else if (isGetList) {
		middle = [
			html`<div class="tp-choices">${passkeyChoices.map((c) => choiceRow(c.credentialId, c.label, undefined))}</div>`,
		];
	} else if (isCreatePicker) {
		const rows = (candidates ?? []).map((c) => choiceRow(c.id, c.name, c.username || undefined));
		rows.push(choiceRow("new", "Create a new login", undefined));
		middle = [html`<div class="tp-choices">${rows}</div>`];
	} else {
		const rows: string[] = [];
		if (existingLoginName) {
			rows.push(
				html`<div class="tp-row"><div class="tp-label">Adds to</div><div>${existingLoginName}</div></div>`,
			);
		}
		if (userName) {
			rows.push(
				html`<div class="tp-row"><div class="tp-label">Account</div><div>${userName}</div></div>`,
			);
		}
		middle = rows;
	}

	// A pickable list acts on row click, so it needs no confirm buttons (dismiss via the ×).
	// A single confirm (locked prompt, or a save with no ambiguity) keeps the button row.
	const actions = hasList
		? []
		: [
				html`<div class="tp-actions">
			<button class="tp-btn tp-btn-primary" data-tp-action="passkey-approve">${primaryLabel}</button>
			<button class="tp-btn" data-tp-action="passkey-dismiss">Not now</button>
		</div>`,
			];

	return html`
		<div class="tp-head">
			<div class="tp-head-main">
				<div class="tp-icon"><span class="tp-glyph"></span></div>
				<div>
					<div class="tp-title">${title}</div>
					<div class="tp-host">${site}</div>
				</div>
			</div>
			<button class="tp-close" data-tp-action="passkey-dismiss" aria-label="Dismiss">×</button>
		</div>
		${middle}
		${actions}
	`;
}
