// Autofill match list for the extension-origin iframe. Holds no secrets; see
// docs/autofill.md ("UI isolation"). Self-contained so the bundle stays flat.

import { html } from "./autofill-ui-template";

interface MatchSummary {
	id: string;
	name: string;
	secondary: string;
}

type Inbound =
	| {
			type: "RENDER_MATCHES";
			matches: MatchSummary[];
			otpOnly?: boolean;
			suggest?: { password: string };
	  }
	| { type: "RENDER_LOCKED" }
	| { type: "UI_KEY"; key: string };

// Page origin (from the iframe src): outbound posts pin to it, inbound is checked against it.
const PARENT_ORIGIN = new URLSearchParams(location.search).get("parentOrigin") ?? "";
// Relayed mode: our element is hosted by the top frame but the field lives in some
// other frame, which answers our probe and becomes the peer we exchange rows and picks
// with. The host frame only ever gets our height. See docs/autofill.md.
const RELAY_ID = new URLSearchParams(location.search).get("relayId") ?? "";
const RELAYED = RELAY_ID.length > 0;
const HERE = "tp-ui-here";
// The announcement has to come FROM here: our host parks us in a closed shadow root,
// and `window.frames` exposes only document-tree child browsing contexts, so the
// field's frame cannot reach us by index. We can still walk outward from the top.
const ANNOUNCE_INTERVAL_MS = 100;
const ANNOUNCE_ATTEMPTS = 25;
const MAX_FRAME_DEPTH = 8;
const MAX_FRAMES_VISITED = 128;
let peer: { win: Window; origin: string } | null = null;

let otpOnly = false;
// Navigable rows in render order: an optional leading "suggest a password" row,
// the login/card matches, or (alone) the locked row. Keyboard + click share this.
type NavRow = { kind: "suggest" } | { kind: "match"; id: string } | { kind: "locked" };
let rows: NavRow[] = [];
let highlight = -1;

function post(message: unknown): void {
	if (RELAYED) {
		// Pinned to the peer's exact origin, so rows reach that frame and nothing else.
		if (peer) peer.win.postMessage(message, peer.origin);
		return;
	}
	if (!PARENT_ORIGIN) return;
	window.parent.postMessage(message, PARENT_ORIGIN);
}

/** Our rendered height, always to the frame that owns our element (never the peer). */
function postHeight(height: number): void {
	if (!PARENT_ORIGIN) return;
	window.parent.postMessage({ type: "UI_RESIZE", height }, PARENT_ORIGIN);
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

// Colours reference the local --tp-* tokens below, never literals. The tokens mirror the
// @vault/theme scale (packages/theme/theme.css); this iframe has no Bramble app shell to read a
// `.dark` class, so light/dark follows the OS via prefers-color-scheme. Byte-identical to the
// shadow renderer's copy (content/html/dropdown-styles.ts); keep both in sync with theme.css.
const STYLE = `
	:root {
		color-scheme: light dark;
		--tp-surface: #ffffff; /* --popover */
		--tp-foreground: oklch(20.5% 0 0); /* --popover-foreground */
		--tp-muted: oklch(55.6% 0 0); /* --muted-foreground */
		--tp-border: oklch(87% 0 0); /* --border */
		--tp-primary: oklch(20.5% 0 0); /* --primary */
		--tp-on-primary: #ffffff; /* --primary-foreground */
	}
	@media (prefers-color-scheme: dark) {
		:root {
			--tp-surface: oklch(26.9% 0 0);
			--tp-foreground: oklch(97% 0 0);
			--tp-muted: oklch(70.8% 0 0);
			--tp-border: oklch(37.1% 0 0);
			--tp-primary: oklch(97% 0 0);
			--tp-on-primary: oklch(20.5% 0 0);
		}
	}
	.tp-list {
		background: var(--tp-surface);
		border: 1px solid var(--tp-border);
		border-radius: 16px;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(0, 0, 0, 0.15);
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
		font-size: 13px;
		color: var(--tp-foreground);
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
	.tp-item:hover { background: color-mix(in oklab, var(--tp-foreground) 8%, transparent); }
	.tp-item.tp-active { background: color-mix(in oklab, var(--tp-foreground) 12%, transparent); }
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
		background: color-mix(in oklab, var(--tp-foreground) 10%, transparent);
		color: var(--tp-muted);
	}
	.tp-avatar-locked svg { width: 20px; height: 20px; }
	.tp-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
	.tp-name {
		font-weight: 600;
		font-size: 15px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--tp-foreground);
		line-height: 1.3;
	}
	.tp-user {
		color: var(--tp-muted);
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
		color: var(--tp-muted);
		transition: color 0.12s ease;
	}
	.tp-item:hover .tp-launch { color: var(--tp-foreground); }
	.tp-avatar-suggest { background: var(--tp-primary); color: var(--tp-on-primary); }
	.tp-avatar-suggest svg { width: 20px; height: 20px; }
	.tp-suggest-pw {
		font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
		font-size: 14px;
		letter-spacing: 0.5px;
	}
	.tp-regenerate {
		margin-left: auto;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		padding: 0;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--tp-muted);
		cursor: pointer;
		transition: background 0.12s ease, color 0.12s ease;
	}
	.tp-regenerate:hover { background: color-mix(in oklab, var(--tp-foreground) 12%, transparent); color: var(--tp-foreground); }
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

function suggestRow(password: string): string {
	return html`
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
		postHeight(list ? Math.ceil(list.getBoundingClientRect().height) : 0);
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
	const n = rows.length;
	if (n === 0) return;
	const next =
		highlight < 0 ? (delta > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, highlight + delta));
	setHighlight(next);
}

/** Fire the action for the row at `i`: pick a match, use the suggestion, or open the pop-out. */
function activate(i: number): void {
	const row = rows[i];
	if (!row) return;
	if (row.kind === "match") post({ type: "UI_PICK", entryId: row.id, otpOnly });
	else if (row.kind === "suggest") post({ type: "UI_USE_SUGGESTED" });
	else post({ type: "UI_POPOUT" });
}

// preventDefault keeps focus on the page field; the page can't reach this listener.
document.addEventListener("mousedown", (e) => {
	if (!e.isTrusted) return;
	const target = e.target as HTMLElement | null;
	// Regenerate lives inside the suggest row, so match it before data-tp-suggest.
	if (target?.closest("[data-tp-regenerate]")) {
		e.preventDefault();
		post({ type: "UI_REGENERATE" });
		return;
	}
	const item = target?.closest<HTMLElement>("[data-entry-id]");
	if (item?.dataset.entryId) {
		e.preventDefault();
		post({ type: "UI_PICK", entryId: item.dataset.entryId, otpOnly });
		return;
	}
	if (target?.closest("[data-tp-suggest]")) {
		e.preventDefault();
		post({ type: "UI_USE_SUGGESTED" });
		return;
	}
	if (target?.closest("[data-tp-popout]")) {
		e.preventDefault();
		post({ type: "UI_POPOUT" });
	}
});

const CONTENT_TYPES = new Set(["RENDER_MATCHES", "RENDER_LOCKED", "UI_KEY"]);

window.addEventListener("message", (e) => {
	if (RELAYED) {
		// Adopt whoever sends us rows as the peer we answer. Anything in the tab can
		// post here, so this binding is not a trust decision: the peer re-checks our
		// origin, our source, and that a picked id is one it actually rendered.
		const type = (e.data as { type?: string } | undefined)?.type;
		if (!e.source || !type || !CONTENT_TYPES.has(type)) return;
		peer = { win: e.source as Window, origin: e.origin };
	} else {
		if (e.source !== window.parent) return;
		if (PARENT_ORIGIN && e.origin !== PARENT_ORIGIN) return;
	}
	const msg = e.data as Inbound | undefined;
	switch (msg?.type) {
		case "RENDER_MATCHES": {
			otpOnly = !!msg.otpOnly;
			highlight = -1;
			rows = [];
			const body: string[] = [];
			if (msg.suggest) {
				rows.push({ kind: "suggest" });
				body.push(suggestRow(msg.suggest.password));
			}
			for (const m of msg.matches) {
				rows.push({ kind: "match", id: m.id });
				body.push(matchRow(m));
			}
			render(body.join(""));
			post({ type: "UI_HIGHLIGHT", active: false });
			break;
		}
		case "RENDER_LOCKED":
			rows = [{ kind: "locked" }];
			highlight = -1;
			render(lockedRow());
			post({ type: "UI_HIGHLIGHT", active: false });
			break;
		case "UI_KEY":
			if (msg.key === "ArrowDown") moveHighlight(1);
			else if (msg.key === "ArrowUp") moveHighlight(-1);
			else if (msg.key === "Enter" && highlight >= 0) activate(highlight);
			break;
	}
});

/**
 * Announce ourselves to every frame in the tab. Carries only our relay id, and the
 * receiver decides whether to trust it by checking our origin, which it can do and we
 * cannot forge. Repeats briefly because the field's frame may still be starting up.
 */
function announce(): void {
	const message = { __tp: HERE, relayId: RELAY_ID };
	let visited = 0;
	const walk = (win: Window, depth: number): void => {
		if (depth > MAX_FRAME_DEPTH || visited >= MAX_FRAMES_VISITED) return;
		let length = 0;
		try {
			length = win.length;
		} catch {
			return;
		}
		for (let i = 0; i < length; i++) {
			if (visited >= MAX_FRAMES_VISITED) return;
			let child: Window | null = null;
			try {
				child = win[i] ?? null;
			} catch {
				continue;
			}
			if (!child || child === window) continue;
			visited++;
			try {
				child.postMessage(message, "*");
			} catch {
				// Frames come and go mid-walk.
			}
			walk(child, depth + 1);
		}
	};
	let root: Window = window;
	try {
		root = window.top ?? window;
	} catch {
		root = window;
	}
	if (root !== window) {
		try {
			root.postMessage(message, "*");
		} catch {
			// Ignore.
		}
	}
	walk(root, 0);
}

if (RELAYED) {
	// Stop as soon as a peer starts talking to us; otherwise give the field's frame a
	// short window to come up.
	let left = ANNOUNCE_ATTEMPTS;
	announce();
	const timer = setInterval(() => {
		if (peer || --left <= 0) {
			clearInterval(timer);
			return;
		}
		announce();
	}, ANNOUNCE_INTERVAL_MS);
} else {
	// Tell the parent we're live so it can push the first RENDER_MATCHES.
	post({ type: "AUTOFILL_UI_READY" });
}
