// Autofill match list for the extension-origin iframe. Holds no secrets; see
// docs/autofill.md ("UI isolation"). Self-contained so the bundle stays flat.

interface MatchSummary {
	id: string;
	name: string;
	secondary: string;
}

type Inbound =
	| { type: "RENDER_MATCHES"; matches: MatchSummary[]; otpOnly?: boolean }
	| { type: "RENDER_LOCKED" }
	| { type: "UI_KEY"; key: string }
	| { type: "CLEAR" };

// Page origin (from the iframe src): outbound posts pin to it, inbound is checked against it.
const PARENT_ORIGIN = new URLSearchParams(location.search).get("parentOrigin") ?? "";

let otpOnly = false;
let currentMatches: MatchSummary[] = [];
// The locked row is a single navigable item (Enter opens the unlock pop-out).
let lockedNav = false;
let highlight = -1;

function post(message: unknown): void {
	if (!PARENT_ORIGIN) return;
	window.parent.postMessage(message, PARENT_ORIGIN);
}

function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Tagged template that html-escapes scalar interpolations; arrays join verbatim. */
function html(strings: TemplateStringsArray, ...values: unknown[]): string {
	let out = strings[0] ?? "";
	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		out += Array.isArray(v) ? v.join("") : escapeHtml(v);
		out += strings[i + 1] ?? "";
	}
	return out;
}

/** Uppercase avatar initials: first letter of the first two words, else first two letters. */
function initials(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "??";
	const words = trimmed.split(/\s+/);
	if (words.length >= 2 && words[0] && words[1]) {
		return (words[0][0]! + words[1][0]!).toUpperCase();
	}
	return trimmed.slice(0, 2).toUpperCase();
}

const AVATAR_COLORS = [
	"#7C3AED",
	"#2563EB",
	"#0891B2",
	"#059669",
	"#65A30D",
	"#CA8A04",
	"#EA580C",
	"#DC2626",
	"#DB2777",
];
function colorForName(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
	return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

const STYLE = `
	.tp-list {
		/* Opaque gradient: backdrop-filter can't frost the page from a cross-origin iframe. */
		background: linear-gradient(135deg, #26262b 0%, #141416 100%);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 16px;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.06);
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
		font-size: 13px;
		color: #fff;
		text-align: left;
		max-height: 360px;
		overflow-y: auto;
		padding: 6px;
		box-sizing: border-box;
	}
	.tp-item {
		padding: 10px 12px;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 12px;
		border-radius: 12px;
		transition: background 0.12s ease;
	}
	.tp-item:hover { background: rgba(255, 255, 255, 0.1); }
	.tp-item.tp-active { background: rgba(255, 255, 255, 0.14); }
	.tp-avatar {
		width: 40px;
		height: 40px;
		border-radius: 11px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 15px;
		font-weight: 700;
		color: #fff;
		flex-shrink: 0;
		letter-spacing: 0.3px;
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18), inset 0 -1px 0 rgba(0, 0, 0, 0.14);
	}
	.tp-avatar-locked {
		background: rgba(255, 255, 255, 0.1);
		color: rgba(255, 255, 255, 0.85);
	}
	.tp-avatar-locked svg { width: 20px; height: 20px; }
	.tp-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
	.tp-name {
		font-weight: 600;
		font-size: 15px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		color: #fff;
		line-height: 1.3;
	}
	.tp-user {
		color: rgba(235, 235, 245, 0.6);
		font-size: 13px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		margin-top: 2px;
		line-height: 1.3;
	}
	.tp-launch {
		margin-left: auto;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		color: rgba(235, 235, 245, 0.45);
		transition: color 0.12s ease;
	}
	.tp-item:hover .tp-launch { color: rgba(235, 235, 245, 0.85); }
`;

function matchRow(m: MatchSummary): string {
	return html`
		<div class="tp-item" data-entry-id="${m.id}" role="option">
			<div class="tp-avatar" style="background: ${colorForName(m.name)};">${initials(m.name)}</div>
			<div class="tp-text">
				<span class="tp-name">${m.name}</span>
				<span class="tp-user">${m.secondary}</span>
			</div>
		</div>
	`;
}

// Extension i18n: browser locale with en default_locale fallback. Kept inline (not a
// shared import) so this WAR iframe bundle stays flat. See content/i18n.ts for the
// content-script twin.
type I18n = { getMessage(key: string): string };
function t(key: string): string {
	const g = globalThis as { browser?: { i18n: I18n }; chrome?: { i18n: I18n } };
	return (g.browser ?? g.chrome)?.i18n.getMessage(key) ?? key;
}

function lockedRow(): string {
	return html`
		<div class="tp-item tp-locked" data-tp-popout="1">
			<div class="tp-avatar tp-avatar-locked">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10.5" width="16" height="10" rx="2.4"></rect><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"></path></svg>
			</div>
			<div class="tp-text">
				<span class="tp-name">${t("vaultLocked")}</span>
				<span class="tp-user">${t("vaultLockedUnlockHint")}</span>
			</div>
			<span class="tp-launch">
				<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"></path><path d="M20 4l-8.5 8.5"></path><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"></path></svg>
			</span>
		</div>
	`;
}

/** Render body html, then report the rendered height so the parent can size the iframe. */
function render(bodyHtml: string): void {
	document.body.innerHTML = `<style>${STYLE}</style><div class="tp-list" role="listbox">${bodyHtml}</div>`;
	requestAnimationFrame(() => {
		const list = document.body.querySelector(".tp-list");
		const height = list ? Math.ceil(list.getBoundingClientRect().height) : 0;
		post({ type: "UI_RESIZE", height });
	});
}

/** Move the keyboard highlight and tell the parent whether a row is selected (gates Enter-to-pick). */
function setHighlight(index: number): void {
	highlight = index;
	const rows = document.body.querySelectorAll<HTMLElement>(".tp-item");
	rows.forEach((row, i) => {
		const active = i === highlight;
		row.classList.toggle("tp-active", active);
		if (active) row.scrollIntoView({ block: "nearest" });
	});
	post({ type: "UI_HIGHLIGHT", active: highlight >= 0 });
}

function moveHighlight(delta: number): void {
	const n = lockedNav ? 1 : currentMatches.length;
	if (n === 0) return;
	const next =
		highlight < 0 ? (delta > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, highlight + delta));
	setHighlight(next);
}

// preventDefault keeps focus on the page field; the page can't reach this listener.
document.addEventListener("mousedown", (e) => {
	if (!e.isTrusted) return;
	const target = e.target as HTMLElement | null;
	const item = target?.closest<HTMLElement>("[data-entry-id]");
	if (item?.dataset.entryId) {
		e.preventDefault();
		post({ type: "UI_PICK", entryId: item.dataset.entryId, otpOnly });
		return;
	}
	if (target?.closest("[data-tp-popout]")) {
		e.preventDefault();
		post({ type: "UI_POPOUT" });
	}
});

window.addEventListener("message", (e) => {
	if (e.source !== window.parent) return;
	if (PARENT_ORIGIN && e.origin !== PARENT_ORIGIN) return;
	const msg = e.data as Inbound | undefined;
	switch (msg?.type) {
		case "RENDER_MATCHES":
			otpOnly = !!msg.otpOnly;
			currentMatches = msg.matches;
			lockedNav = false;
			highlight = -1;
			render(msg.matches.map(matchRow).join(""));
			post({ type: "UI_HIGHLIGHT", active: false });
			break;
		case "RENDER_LOCKED":
			currentMatches = [];
			lockedNav = true;
			highlight = -1;
			render(lockedRow());
			post({ type: "UI_HIGHLIGHT", active: false });
			break;
		case "UI_KEY":
			if (msg.key === "ArrowDown") moveHighlight(1);
			else if (msg.key === "ArrowUp") moveHighlight(-1);
			else if (msg.key === "Enter" && highlight >= 0) {
				if (lockedNav) post({ type: "UI_POPOUT" });
				else {
					const m = currentMatches[highlight];
					if (m) post({ type: "UI_PICK", entryId: m.id, otpOnly });
				}
			}
			break;
		case "CLEAR":
			currentMatches = [];
			lockedNav = false;
			highlight = -1;
			document.body.innerHTML = "";
			break;
	}
});

// Tell the parent we're live so it can push the first RENDER_MATCHES.
post({ type: "AUTOFILL_UI_READY" });
