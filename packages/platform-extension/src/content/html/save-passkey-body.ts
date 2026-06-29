import { html } from "../template";

/** The passkey provider corner card: confirm creating or using a passkey for a site. */
export function savePasskeyBody({
	rpId,
	rpName,
	userName,
	intent,
	existingLoginName,
	primaryLabel,
}: {
	rpId: string;
	rpName?: string;
	userName?: string;
	intent: "create" | "get";
	existingLoginName?: string;
	primaryLabel: string;
}) {
	const title =
		intent === "get"
			? "Use your passkey?"
			: existingLoginName
				? "Add a passkey?"
				: "Save a passkey?";
	// Avoid "x (x)" when the RP's display name equals its id.
	const site = rpName && rpName !== rpId ? `${rpName} (${rpId})` : rpId;
	// Nested html escapes the interpolated values; the array interpolation joins markup
	// verbatim (a scalar string interpolation would be html-escaped and show as text).
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
	return html`
		<div class="tp-head">
			<div>
				<div class="tp-title">${title}</div>
				<div class="tp-host">${site}</div>
			</div>
			<button class="tp-close" data-tp-action="passkey-dismiss" aria-label="Dismiss">×</button>
		</div>
		${rows}
		<div class="tp-actions">
			<button class="tp-btn tp-btn-primary" data-tp-action="passkey-approve">${primaryLabel}</button>
			<button class="tp-btn" data-tp-action="passkey-dismiss">Not now</button>
		</div>
	`;
}
