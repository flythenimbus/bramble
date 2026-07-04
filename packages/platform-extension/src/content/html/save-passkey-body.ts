import { html } from "../template";

// Passkey glyph (lucide "key-round"), so the card reads as a passkey at a glance. Static
// markup injected verbatim (via an array interpolation) — no user data, nothing to escape.
const passkeyIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>`;

/** The passkey provider corner card: confirm creating/using a passkey, or pick which
 * login a new passkey attaches to (radios + "Create a new login" last) when several
 * accounts share the domain. */
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
	const isGetPicker = intent === "get" && !!passkeyChoices && passkeyChoices.length > 0;
	const title = isGetPicker
		? "Sign in with which passkey?"
		: isCreatePicker
			? "Add this passkey to…"
			: intent === "get"
				? "Use your passkey?"
				: existingLoginName
					? "Add a passkey?"
					: "Save a passkey?";

	// Nested html escapes the interpolated values; outer array interpolations join the
	// markup verbatim (a scalar string interpolation would be html-escaped and show as text).
	// Radios share name="tp-passkey-target"; the content script sends the checked value
	// back as `choice` (a login id / "new" for create, a credentialId for get).
	const radio = (value: string, name: string, sub: string | undefined, checked: boolean) =>
		html`<label class="tp-row" style="cursor:pointer;align-items:flex-start;gap:8px">
			<input type="radio" name="tp-passkey-target" value="${value}"${checked ? " checked" : ""} style="margin-top:3px" />
			<div><div>${name}</div>${sub ? [html`<div class="tp-label">${sub}</div>`] : []}</div>
		</label>`;
	let middle: string[] = [];
	if (isGetPicker) {
		const rows = (passkeyChoices ?? []).map((c, i) =>
			radio(c.credentialId, c.label, undefined, i === 0),
		);
		middle = [html`<div class="tp-choices">${rows}</div>`];
	} else if (isCreatePicker) {
		const rows = (candidates ?? []).map((c) => radio(c.id, c.name, c.username, false));
		// "Create a new login" is the last option, and the default selection.
		rows.push(radio("new", "Create a new login", undefined, true));
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
				<div class="tp-icon">${[passkeyIcon]}</div>
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
