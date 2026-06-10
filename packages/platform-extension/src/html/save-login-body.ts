export function saveLoginBody({
	hostname,
	username,
	password,
	primaryAction,
	primaryLabel,
}: {
	hostname: string;
	username: string;
	password: string;
	primaryAction: string;
	primaryLabel: string;
}) {
	return html`
		<div class="tp-head">
			<div>
				<div class="tp-title">Save New Login</div>
				<div class="tp-host">${hostname}</div>
			</div>
			<button class="tp-close" data-tp-action="dismiss" aria-label="Dismiss">×</button>
		</div>
		<div class="tp-row">
			<div class="tp-label">Username</div>
			<input class="tp-input" id="tp-username" type="text" value="${username}" autocomplete="off" />
		</div>
		<div class="tp-row">
			<div class="tp-label">Password</div>
			<div class="tp-password-wrap">
				<input class="tp-input" id="tp-password" type="password" value="${password}" autocomplete="off" readonly />
				<button class="tp-password-toggle" data-tp-action="toggle-password">Show</button>
			</div>
		</div>
		<div class="tp-actions">
			<button class="tp-btn tp-btn-primary" data-tp-action="${primaryAction}">${primaryLabel}</button>
			<button class="tp-btn" data-tp-action="dismiss">Not now</button>
			<button class="tp-overflow" data-tp-action="toggle-menu" aria-label="More">⋯</button>
		</div>
	`;
}
