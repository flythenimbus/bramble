import { t } from "../i18n";
import { html } from "../template";

/** Shadow-renderer "new login" link (COEP fallback twin of the iframe one): opens the create form
 * for this site, under the logins it already has (#213). */
export const dropdownNewLogin = (): string => html`
		<button type="button" class="tp-new-login" data-tp-new-login="1">
			<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>
			${t("newLoginTitle")}
		</button>
	`;
