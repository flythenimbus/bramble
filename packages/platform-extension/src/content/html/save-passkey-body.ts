import { html } from "../template";

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

/** One selectable account row: an initials avatar + a primary label (+ optional sub). The
 *  hidden radio drives selection; the content script reads the checked value as `choice`. */
function choiceRow(value: string, primary: string, sub: string | undefined, checked: boolean) {
	return html`<label class="tp-choice">
		<input type="radio" name="tp-passkey-target" value="${value}"${checked ? " checked" : ""} />
		<span class="tp-avatar">${initialsOf(primary)}</span>
		<span class="tp-choice-text">
			<span class="tp-choice-primary">${primary}</span>
			${sub ? [html`<span class="tp-choice-sub">${sub}</span>`] : []}
		</span>
	</label>`;
}

/** The passkey provider corner card: confirm creating/using a passkey, or pick which
 * account when several passkeys/logins share the domain. Every stored passkey is shown
 * with an avatar + its account name so the user knows exactly who they're signing in as. */
export function savePasskeyBody({
	rpId,
	rpName,
	userName,
	intent,
	existingLoginName,
	candidates,
	passkeyChoices,
	primaryLabel,
}: {
	rpId: string;
	rpName?: string;
	userName?: string;
	intent: "create" | "get";
	existingLoginName?: string;
	candidates?: { id: string; name: string; username: string }[];
	passkeyChoices?: { credentialId: string; label: string }[];
	primaryLabel: string;
}) {
	// Avoid "x (x)" when the RP's display name equals its id.
	const site = rpName && rpName !== rpId ? `${rpName} (${rpId})` : rpId;
	const isCreatePicker = intent === "create" && !!candidates && candidates.length > 0;
	const isGetList = intent === "get" && !!passkeyChoices && passkeyChoices.length > 0;
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
	if (isGetList) {
		// Every matching passkey, first preselected. One row still shows who you'll sign in as.
		const rows = passkeyChoices.map((c, i) =>
			choiceRow(c.credentialId, c.label, undefined, i === 0),
		);
		middle = [html`<div class="tp-choices">${rows}</div>`];
	} else if (isCreatePicker) {
		const rows = (candidates ?? []).map((c) =>
			choiceRow(c.id, c.name, c.username || undefined, false),
		);
		// "Create a new login" is the last option, and the default selection.
		rows.push(choiceRow("new", "Create a new login", undefined, true));
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
		<div class="tp-actions">
			<button class="tp-btn tp-btn-primary" data-tp-action="passkey-approve">${primaryLabel}</button>
			<button class="tp-btn" data-tp-action="passkey-dismiss">Not now</button>
		</div>
	`;
}
