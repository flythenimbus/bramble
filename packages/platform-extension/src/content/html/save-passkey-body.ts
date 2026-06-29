import { html } from "../template";

/** The passkey provider corner card: confirm creating or using a passkey for a site. */
export function savePasskeyBody({
	rpId,
	rpName,
	userName,
	intent,
	primaryLabel,
}: {
	rpId: string;
	rpName?: string;
	userName?: string;
	intent: "create" | "get";
	primaryLabel: string;
}) {
	const title = intent === "create" ? "Save a passkey?" : "Use your passkey?";
	const site = rpName ? `${rpName} (${rpId})` : rpId;
	const account = userName
		? `<div class="tp-row"><div class="tp-label">Account</div><div>${userName}</div></div>`
		: "";
	return html`
		<div class="tp-head">
			<div>
				<div class="tp-title">${title}</div>
				<div class="tp-host">${site}</div>
			</div>
			<button class="tp-close" data-tp-action="passkey-dismiss" aria-label="Dismiss">×</button>
		</div>
		${account}
		<div class="tp-actions">
			<button class="tp-btn tp-btn-primary" data-tp-action="passkey-approve">${primaryLabel}</button>
			<button class="tp-btn" data-tp-action="passkey-dismiss">Not now</button>
		</div>
	`;
}
