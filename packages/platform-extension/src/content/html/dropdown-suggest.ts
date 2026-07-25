import { t } from "../i18n";
import { html } from "../template";

/** Shadow-renderer "use a generated password" row (COEP fallback twin of the iframe row). */
export const dropdownSuggest = (password: string): string => html`
		<div class="tp-item tp-suggest" data-tp-suggest="1" role="option">
			<div class="tp-avatar tp-avatar-suggest">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4.5"></circle><path d="M10.7 12.3 20 3"></path><path d="m16 6 3 3"></path><path d="m14 8 3 3"></path></svg>
			</div>
			<div class="tp-text">
				<span class="tp-name tp-suggest-pw">${password}</span>
				<span class="tp-user">${t("suggestPasswordUse")}</span>
			</div>
			<button class="tp-regenerate" data-tp-regenerate="1" type="button" aria-label="${t("suggestPasswordRegenerate")}">
				<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path><path d="M3 21v-5h5"></path></svg>
			</button>
		</div>
	`;
