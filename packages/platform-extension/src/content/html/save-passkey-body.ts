import { html } from "../template";

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
	primaryLabel,
}: {
	rpId: string;
	rpName?: string;
	userName?: string;
	intent: "create" | "get";
	existingLoginName?: string;
	candidates?: { id: string; name: string; username: string }[];
	primaryLabel: string;
}) {
	// Avoid "x (x)" when the RP's display name equals its id.
	const site = rpName && rpName !== rpId ? `${rpName} (${rpId})` : rpId;
	const isPicker = intent === "create" && !!candidates && candidates.length > 0;
	const title = isPicker
		? "Add this passkey to…"
		: intent === "get"
			? "Use your passkey?"
			: existingLoginName
				? "Add a passkey?"
				: "Save a passkey?";

	// Nested html escapes the interpolated values; outer array interpolations join the
	// markup verbatim (a scalar string interpolation would be html-escaped and show as text).
	let middle: string[] = [];
	if (isPicker) {
		const radio = (value: string, name: string, sub?: string) =>
			html`<label class="tp-row" style="cursor:pointer;align-items:flex-start;gap:8px">
				<input type="radio" name="tp-passkey-target" value="${value}" style="margin-top:3px" />
				<div><div>${name}</div>${sub ? [html`<div class="tp-label">${sub}</div>`] : []}</div>
			</label>`;
		const rows = (candidates ?? []).map((c) => radio(c.id, c.name, c.username));
		// "Create a new login" is the last option, and the default selection.
		rows.push(
			html`<label class="tp-row" style="cursor:pointer;gap:8px">
				<input type="radio" name="tp-passkey-target" value="new" checked />
				<div>Create a new login</div>
			</label>`,
		);
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
			<div>
				<div class="tp-title">${title}</div>
				<div class="tp-host">${site}</div>
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
