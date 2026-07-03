import { t } from "../i18n";
import { html } from "../template";

export const dropdownLocked = (): string => html`
		<div class="tp-item tp-locked" data-tp-popout="1">
			<div class="tp-avatar tp-avatar-locked">🔒</div>
			<div class="tp-text">
				<span class="tp-name">${t("vaultLocked")}</span>
				<span class="tp-user">${t("vaultLockedUnlockHint")}</span>
			</div>
		</div>
	`;
