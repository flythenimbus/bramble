/// <reference types="chrome" />


let extensionAlive = true;
let mutationObserver: MutationObserver | null = null;

function isExtensionAlive(): boolean {
	if (!extensionAlive) return false;
	if (!chrome.runtime?.id) {
		extensionAlive = false;
		teardown();
		return false;
	}
	return true;
}

function teardown(): void {
	mutationObserver?.disconnect();
	mutationObserver = null;
	removeDropdown();
}

function safeSendMessage(message: unknown): void {
	if (!isExtensionAlive()) return;
	try {
		chrome.runtime.sendMessage(message);
	} catch {
		extensionAlive = false;
		teardown();
	}
}


interface MatchSummary {
	id: string;
	name: string;
	username: string;
}

interface FindResult {
	matches: MatchSummary[];
	locked: boolean;
	hasPotentialMatch: boolean;
}

interface FillPayload {
	username: string;
	password: string;
}

interface LoginFields {
	username: HTMLInputElement | null;
	password: HTMLInputElement | null;
}

const EMPTY_RESULT: FindResult = { matches: [], locked: true, hasPotentialMatch: false };


const USERNAME_HINT_RE = /email|e-mail|user|login|account|signin|sign-in/i;
const NEGATIVE_HINT_RE = /search|captcha|coupon|otp|code/i;

const USERNAME_TEXT_SELECTOR =
	'input[type="text"]:not([readonly]):not([disabled]), input[type="email"]:not([readonly]):not([disabled]), input[type="tel"]:not([readonly]):not([disabled]), input:not([type]):not([readonly]):not([disabled])';

function findPasswordField(): HTMLInputElement | null {
	return document.querySelector<HTMLInputElement>(
		'input[type="password"]:not([readonly]):not([disabled])',
	);
}

function attrHint(el: HTMLInputElement): string {
	return `${el.name} ${el.id} ${el.placeholder} ${el.autocomplete} ${el.getAttribute("aria-label") ?? ""}`;
}

function looksLikeUsername(el: HTMLInputElement): boolean {
	const hint = attrHint(el);
	if (NEGATIVE_HINT_RE.test(hint)) return false;
	if (el.type === "email") return true;
	const autocomplete = el.autocomplete?.toLowerCase() ?? "";
	if (autocomplete.includes("username") || autocomplete === "email") return true;
	return USERNAME_HINT_RE.test(hint);
}

function findUsernameNearPassword(password: HTMLInputElement): HTMLInputElement | null {
	const form = password.closest("form");
	const scope: ParentNode = form ?? document;
	const candidates = scope.querySelectorAll<HTMLInputElement>(USERNAME_TEXT_SELECTOR);
	let best: HTMLInputElement | null = null;
	for (const c of candidates) {
		if (c === password) continue;
		if (NEGATIVE_HINT_RE.test(attrHint(c))) continue;
		const pos = c.compareDocumentPosition(password);
		if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
			best = c;
		}
	}
	return best;
}

function detectLoginFields(): LoginFields {
	const password = findPasswordField();

	// 1. If there's a password field, the nearest preceding text input is the
	//    username — that pairing is by far the most reliable signal.
	if (password) {
		const near = findUsernameNearPassword(password);
		if (near) return { username: near, password };
	}

	// 2. Explicit autocomplete tokens take priority over heuristics.
	const explicit = document.querySelector<HTMLInputElement>(
		'input[autocomplete~="username"]:not([readonly]):not([disabled]), input[autocomplete="email"]:not([readonly]):not([disabled])',
	);
	if (explicit) return { username: explicit, password };

	// 3. A single visible email input is almost always the username.
	const email = document.querySelector<HTMLInputElement>(
		'input[type="email"]:not([readonly]):not([disabled])',
	);
	if (email) return { username: email, password };

	// 4. Fall back to attribute heuristics on text inputs.
	const candidates = document.querySelectorAll<HTMLInputElement>(USERNAME_TEXT_SELECTOR);
	for (const c of candidates) {
		if (looksLikeUsername(c)) return { username: c, password };
	}

	return { username: null, password };
}

function isAutofillCandidate(el: EventTarget | null): el is HTMLInputElement {
	if (!(el instanceof HTMLInputElement)) return false;
	if (el.readOnly || el.disabled) return false;
	if (el.type === "password") return true;
	const fields = detectLoginFields();
	return el === fields.username;
}


function setNativeValue(el: HTMLInputElement, value: string): void {
	const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
	desc?.set?.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

function fillField(el: HTMLInputElement, value: string): void {
	setNativeValue(el, value);
	el.dispatchEvent(new Event("change", { bubbles: true }));
}

const autoFilledFields = new WeakSet<HTMLInputElement>();

function fillForm(username: string, password: string, isAuto: boolean): boolean {
	const { username: userField, password: pwField } = detectLoginFields();
	let filled = false;
	if (userField && !(isAuto && autoFilledFields.has(userField))) {
		fillField(userField, username);
		autoFilledFields.add(userField);
		filled = true;
	}
	if (pwField && !(isAuto && autoFilledFields.has(pwField))) {
		fillField(pwField, password);
		autoFilledFields.add(pwField);
		filled = true;
	}
	return filled;
}


const DROPDOWN_ID = "titanpass-autofill-dropdown";

let dropdownEl: HTMLElement | null = null;
let cachedResult: FindResult = EMPTY_RESULT;
let anchorField: HTMLInputElement | null = null;

function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function html(strings: TemplateStringsArray, ...values: unknown[]): string {
	let out = strings[0] ?? "";
	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		out += Array.isArray(v) ? v.join("") : escapeHtml(v);
		out += strings[i + 1] ?? "";
	}
	return out;
}

function removeDropdown(): void {
	if (dropdownEl) {
		dropdownEl.remove();
		dropdownEl = null;
	}
	anchorField = null;
}

function positionDropdown(field: HTMLInputElement): void {
	if (!dropdownEl) return;
	const rect = field.getBoundingClientRect();
	dropdownEl.style.top = `${rect.bottom + window.scrollY + 2}px`;
	dropdownEl.style.left = `${rect.left + window.scrollX}px`;
	const width = Math.max(rect.width / 3, 240);
	dropdownEl.style.width = `${width}px`;
}

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

function dropdownStyles(): string {
	return html`
		<style>
			#${DROPDOWN_ID} {
				background: rgba(28, 28, 30, 0.96);
				-webkit-backdrop-filter: saturate(180%) blur(20px);
				backdrop-filter: saturate(180%) blur(20px);
				border: 1px solid rgba(255, 255, 255, 0.06);
				border-radius: 14px;
				box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(0, 0, 0, 0.3);
				font-family:
					-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
				font-size: 13px;
				color: #fff;
				max-height: 320px;
				overflow-y: auto;
				padding: 4px;
				box-sizing: border-box;
			}
			#${DROPDOWN_ID} .tp-item {
				padding: 6px 8px;
				cursor: pointer;
				display: flex;
				align-items: center;
				gap: 12px;
				border-radius: 10px;
				transition: background 0.1s ease;
			}
			#${DROPDOWN_ID} .tp-item:hover {
				background: rgba(255, 255, 255, 0.08);
			}
			#${DROPDOWN_ID} .tp-locked {
				cursor: default;
			}
			#${DROPDOWN_ID} .tp-locked:hover {
				background: transparent;
			}
			#${DROPDOWN_ID} .tp-avatar {
				width: 40px;
				height: 40px;
				border-radius: 10px;
				display: flex;
				align-items: center;
				justify-content: center;
				font-size: 14px;
				font-weight: 600;
				color: #fff;
				flex-shrink: 0;
				letter-spacing: 0.5px;
			}
			#${DROPDOWN_ID} .tp-avatar-locked {
				background: rgba(255, 255, 255, 0.08);
				color: rgba(255, 255, 255, 0.6);
				font-size: 18px;
			}
			#${DROPDOWN_ID} .tp-text {
				display: flex;
				flex-direction: column;
				min-width: 0;
				flex: 1;
			}
			#${DROPDOWN_ID} .tp-name {
				font-weight: 600;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				color: #fff;
				line-height: 1.3;
			}
			#${DROPDOWN_ID} .tp-user {
				color: rgba(235, 235, 245, 0.55);
				font-size: 12px;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				margin-top: 2px;
				line-height: 1.3;
			}
		</style>
	`;
}

function mountDropdown(field: HTMLInputElement, bodyHtml: string): HTMLElement {
	removeDropdown();
	anchorField = field;

	const root = document.createElement("div");
	root.id = DROPDOWN_ID;
	root.style.cssText = "position: absolute; z-index: 2147483647;";
	root.innerHTML = dropdownStyles() + bodyHtml;

	dropdownEl = root;
	document.body.appendChild(dropdownEl);
	positionDropdown(field);
	return root;
}

function buildDropdown(matches: MatchSummary[], field: HTMLInputElement): void {
	if (matches.length === 0) return;

	const body = html`
		${matches.map(
			(m) => html`
				<div class="tp-item" data-entry-id="${m.id}">
					<div class="tp-avatar" style="background: ${colorForName(m.name)};">
						${initials(m.name)}
					</div>
					<div class="tp-text">
						<span class="tp-name">${m.name}</span>
						<span class="tp-user">${m.username}</span>
					</div>
				</div>
			`,
		)}
	`;
	const root = mountDropdown(field, body);

	root.addEventListener("mousedown", (e) => {
		const item = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-entry-id]");
		if (!item) return;
		e.preventDefault();
		const id = item.dataset.entryId;
		if (id) selectMatch(id, false);
	});
}

function buildLockedDropdown(field: HTMLInputElement): void {
	const body = html`
		<div class="tp-item tp-locked">
			<div class="tp-avatar tp-avatar-locked">🔒</div>
			<div class="tp-text">
				<span class="tp-name">Vault locked</span>
				<span class="tp-user">Click the icon to unlock</span>
			</div>
		</div>
	`;
	mountDropdown(field, body);
}

// The AUTOFILL_FILL response from the background can't distinguish auto vs.
// manual selection, so we stash the intent here and read it when the fill
// message comes back.
let pendingFillIsAuto = false;

function selectMatch(entryId: string, isAuto: boolean): void {
	pendingFillIsAuto = isAuto;
	removeDropdown();
	safeSendMessage({
		type: "AUTOFILL_SELECT",
		payload: { entryId, hostname: location.hostname },
	});
}


function focusedCandidate(): HTMLInputElement | null {
	const focused = document.activeElement;
	return focused instanceof HTMLInputElement && isAutofillCandidate(focused) ? focused : null;
}

function isFindResult(v: unknown): v is FindResult {
	return (
		typeof v === "object" &&
		v !== null &&
		Array.isArray((v as FindResult).matches) &&
		typeof (v as FindResult).locked === "boolean"
	);
}

// Cache the query result. The only proactive UI action is single-match
// auto-fill — anything that needs the dropdown waits for the user to focus
// the field (handled in `showFor`). This stops re-queries from MutationObserver
// or page state changes from springing the dropdown back open after the user
// clicks away.
function handleResult(result: FindResult | undefined): void {
	// Background may forward `undefined` when offscreen erred (e.g. it was
	// killed and the new instance's listener wasn't ready). Fall back to a
	// locked state instead of letting `cachedResult` become undefined.
	if (!isFindResult(result)) {
		cachedResult = EMPTY_RESULT;
		return;
	}
	cachedResult = result;

	if (result.locked) {
		const f = focusedCandidate();
		if (f) buildLockedDropdown(f);
		return;
	}

	if (result.matches.length === 0) return;

	if (result.matches.length === 1) {
		// Re-queries from the MutationObserver shouldn't keep re-firing the
		// auto-fill. If every detectable field is already in `autoFilledFields`
		// the fill is a no-op anyway — but `selectMatch` would still remove
		// any visible dropdown as a side effect, causing the flicker. Skip.
		const fields = detectLoginFields();
		const userDone = !fields.username || autoFilledFields.has(fields.username);
		const passDone = !fields.password || autoFilledFields.has(fields.password);
		if (userDone && passDone) return;
		selectMatch(result.matches[0]!.id, true);
		return;
	}

	const f = focusedCandidate();
	if (f) buildDropdown(result.matches, f);
}


function queryAutofill(): void {
	const { username, password } = detectLoginFields();
	if (!username && !password) return;

	safeSendMessage({
		type: "AUTOFILL_QUERY",
		hostname: location.hostname,
	});
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.type === "AUTOFILL_MATCHES") {
		handleResult(message.payload as FindResult | undefined);
		sendResponse({ ok: true });
		return false;
	}

	if (message?.type === "AUTOFILL_FILL") {
		const { username, password } = message.payload as FillPayload;
		const isAuto = pendingFillIsAuto;
		pendingFillIsAuto = false;
		removeDropdown();
		const ok = fillForm(username, password, isAuto);
		sendResponse({ ok });
		return false;
	}

	return false;
});

let lastCheck = 0;
function onDomChange(): void {
	const now = Date.now();
	if (now - lastCheck < 500) return;
	lastCheck = now;
	queryAutofill();
}

function showFor(field: HTMLInputElement): void {
	if (cachedResult.locked) {
		// Always offer the unlock hint when the user touches a login field —
		buildLockedDropdown(field);
		return;
	}
	if (cachedResult.matches.length === 0) {
		queryAutofill();
		return;
	}
	if (cachedResult.matches.length > 1 || !field.value) {
		buildDropdown(cachedResult.matches, field);
	}
}

function bootstrap(): void {
	queryAutofill();

	mutationObserver = new MutationObserver(() => onDomChange());
	mutationObserver.observe(document.body, { childList: true, subtree: true });

	document.addEventListener(
		"focusin",
		(e) => {
			if (!isAutofillCandidate(e.target)) return;
			showFor(e.target);
		},
		true,
	);

	document.addEventListener(
		"input",
		(e) => {
			if (!isAutofillCandidate(e.target)) return;
			if (e.target.value && cachedResult.matches.length <= 1 && !cachedResult.locked) {
				// User is typing their own value — get out of the way unless
				// they have multiple matches to disambiguate.
				removeDropdown();
				return;
			}
			showFor(e.target);
		},
		true,
	);

	document.addEventListener(
		"click",
		(e) => {
			if (!dropdownEl) return;
			const target = e.target as Node;
			if (dropdownEl.contains(target)) return;
			// Clicking the field that owns the dropdown is what just opened
			// it — closing here would make it flash open and shut.
			if (anchorField && anchorField.contains(target)) return;
			removeDropdown();
		},
		true,
	);
	window.addEventListener(
		"scroll",
		() => {
			if (dropdownEl && anchorField) {
				positionDropdown(anchorField);
			}
		},
		true,
	);
	window.addEventListener(
		"resize",
		() => {
			if (dropdownEl && anchorField) {
				positionDropdown(anchorField);
			}
		},
		true,
	);
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", bootstrap);
} else {
	bootstrap();
}
