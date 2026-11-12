import { t } from "../i18n";
import { html } from "../template";

/** Shadow-renderer "new login" row (COEP fallback twin of the iframe row): opens the create form
 * for this site, under the logins it already has (#213). */
export const dropdownNewLogin = (): string => html`
		<div class="tp-item tp-new-login" data-tp-new-login="1" role="option">
			<div class="tp-avatar tp-avatar-suggest">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>
			</div>
			<div class="tp-text">
				<span class="tp-name">${t("newLoginTitle")}</span>
				<span class="tp-user">${t("newLoginUse")}</span>
			</div>
		</div>
	`;
