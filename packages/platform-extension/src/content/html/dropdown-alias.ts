import { t } from "../i18n";
import { html } from "../template";

/**
 * The email-alias row's state, and the reason this row is not the suggested-password row.
 *
 * A generated password costs nothing, so its row is drawn already holding one. An alias is a real
 * record on the user's provider account against a real allowance, so it cannot be made until the
 * user asks: the row starts as an invitation, spends time in flight, and can fail in ways only
 * the provider can explain. See docs/email-aliases.md.
 */
export type AliasRowState =
	| { state: "idle" }
	| { state: "busy" }
	/** `message` is the provider's own words when it gave any. */
	| { state: "error"; message?: string };

/**
 * Shadow-renderer "use an email alias" row (COEP fallback twin of the iframe row).
 *
 * Written as one literal per state rather than one template with the markup interpolated in:
 * `html` escapes scalars and joins only arrays verbatim, so interpolating markup means opting
 * out of the escaping, next to a `message` that is remote-controlled text and must never opt
 * out. Three plain templates cost a few lines and remove the question.
 */
export function dropdownAlias(row: AliasRowState): string {
	// Busy is not clickable: a second request while one is in flight makes two aliases and
	// spends two of the user's allowance for one gesture.
	if (row.state === "busy") {
		return html`
		<div class="tp-item tp-alias tp-alias-busy">
			<div class="tp-avatar tp-avatar-alias">
				<svg class="tp-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
			</div>
			<div class="tp-text">
				<span class="tp-name">${t("aliasTitle")}</span>
				<span class="tp-user">${t("aliasWorking")}</span>
			</div>
		</div>
	`;
	}
	if (row.state === "error") {
		// The provider's own words go through the escaper like any other page-bound string, and
		// are rendered as text: one measured provider answers with a URL inside its message.
		return html`
		<div class="tp-item tp-alias tp-alias-error" data-tp-alias="1" role="option">
			<div class="tp-avatar tp-avatar-alias">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path></svg>
			</div>
			<div class="tp-text">
				<span class="tp-name">${t("aliasFailed")}</span>
				<span class="tp-user">${row.message ?? t("aliasRetry")}</span>
			</div>
		</div>
	`;
	}
	return html`
		<div class="tp-item tp-alias" data-tp-alias="1" role="option">
			<div class="tp-avatar tp-avatar-alias">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"></path></svg>
			</div>
			<div class="tp-text">
				<span class="tp-name">${t("aliasTitle")}</span>
				<span class="tp-user">${t("aliasUse")}</span>
			</div>
		</div>
	`;
}
