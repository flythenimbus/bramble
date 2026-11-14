/// <reference types="chrome" />

import { api } from "./content-api";
import { cornerStyles } from "./html/corner-styles";
import { saveLoginBody } from "./html/save-login-body";
import { savePasskeyBody } from "./html/save-passkey-body";
import { updateLoginBody } from "./html/update-login-body";
import { t } from "./i18n";
import { EARLY_CLICK_MS, isLegible } from "./legibility";
import { isExtensionAlive, markExtensionDead, onTeardown, safeSendMessage } from "./lifecycle";
import { html } from "./template";
import type { CornerPromptPayload } from "./types";

const CORNER_ID = "bramble-corner-prompt";

// The save/update card is page-level UI, so render it only in the top frame.
// Capture still runs in every frame (so logins inside an iframe, e.g. Apple ID,
// are caught); the resulting prompt is shown once, on the page itself.
const isTopFrame = (): boolean => window.top === window.self;

let cornerPromptEl: HTMLElement | null = null;
// Closed shadow root of the corner prompt; in-card DOM queries go through this.
let cornerShadow: ShadowRoot | null = null;
let currentPrompt: CornerPromptPayload | null = null;
let cornerShownAt = 0;

// The save card's Username is typed in an extension-origin frame: a box in the page's own
// document, closed shadow root or not, hands the page every keystroke. See docs/autofill.md.
const FIELD_URL = api.runtime.getURL("corner-field.html");
// How long a save waits for the frame's latest text before settling for the last it pushed.
const FIELD_FLUSH_MS = 1000;

interface UsernameField {
	id: string;
	frame: HTMLIFrameElement;
	/** The read-only box, shown until the frame reports and for good where the page blocks it. */
	box: HTMLInputElement;
	/** The frame's text as last reported; null until it has loaded. */
	value: string | null;
}
let usernameField: UsernameField | null = null;
let flushCount = 0;
let pendingFlush: { n: number; done: () => void } | null = null;
// A save waiting on the frame's text; the card takes no other click until it lands.
let saving = false;

// Passkey consent counts only on a card the user can see, and not in its first moments (a click
// aimed at whatever sat there before): a page could otherwise fade or cover it under the cursor.
const PASSKEY_CONSENT = new Set(["passkey-approve", "passkey-pick"]);

function consentClickCounts(): boolean {
	if (!cornerPromptEl || !isLegible(cornerPromptEl)) return false;
	return Date.now() - cornerShownAt >= EARLY_CLICK_MS;
}

function removeCornerPrompt(): void {
	if (cornerPromptEl) {
		cornerPromptEl.remove();
		cornerPromptEl = null;
	}
	cornerShadow = null;
	currentPrompt = null;
	usernameField = null;
	saving = false;
	pendingFlush?.done();
}

/** Picks up a save/update prompt stashed by a prior page's submit (post-navigation capture). */
export function queryCornerPrompt(): void {
	if (!isTopFrame()) return;
	if (!isExtensionAlive()) return;
	try {
		api.runtime
			.sendMessage({ type: "CORNER_PROMPT_QUERY" })
			.then((resp: { ok: boolean; data?: CornerPromptPayload | null } | undefined) => {
				if (!resp?.ok || !resp.data) return;
				handleCornerPromptShow(resp.data);
			})
			.catch(() => {});
	} catch {
		markExtensionDead();
	}
}

/** Renders the "Save New Login" card body. */
function buildSaveLoginBody(p: Extract<CornerPromptPayload, { kind: "save-login" }>): string {
	const primaryLabel = t(p.locked ? "actionUnlockAndSave" : "actionSave");
	const primaryAction = p.locked ? "save-unlock-first" : "save";
	const { username, password, hostname } = p;
	return saveLoginBody({
		username,
		password,
		hostname,
		primaryAction,
		primaryLabel,
	});
}

/** Renders the "Update login" card body; "Save as new" keeps existing entries instead of rotating. */
function buildUpdateLoginBody(p: Extract<CornerPromptPayload, { kind: "update-login" }>): string {
	const primaryLabel = t(p.locked ? "actionUnlockAndUpdate" : "actionUpdate");
	const primaryAction = p.locked ? "save-unlock-first" : "update";
	// >1 candidate: ask which entry to update; exactly 1: confirm the rotation.
	const title = t(p.candidates.length > 1 ? "updateExistingTitle" : "updateSavedTitle");
	return updateLoginBody({
		title,
		hostname: p.hostname,
		primaryAction,
		primaryLabel,
		candidates: p.candidates,
	});
}

function sendCornerResponse(action: string, extra?: Record<string, unknown>): void {
	if (!currentPrompt) return;
	safeSendMessage({
		type: "CORNER_PROMPT_RESPONSE",
		payload: { promptId: currentPrompt.promptId, action, ...extra },
	});
}

// Passkey cards reply on their own channel: the create()/get() call is blocking on
// the background, which resolves the pending proxy request from this message. On approve,
// include the picked login id (or "new") when the card is a create picker.
function sendPasskeyResponse(approved: boolean, explicitChoice?: string): void {
	if (!currentPrompt) return;
	// The row-click flow passes the picked value directly; the button flow (no list) reads a
	// checked radio if present (there is none when there's nothing to choose).
	let choice = explicitChoice;
	if (approved && choice === undefined) {
		choice = cornerShadow?.querySelector<HTMLInputElement>(
			'input[name="tp-passkey-target"]:checked',
		)?.value;
	}
	safeSendMessage({
		type: "PASSKEY_PROMPT_RESPONSE",
		payload: { promptId: currentPrompt.promptId, approved, ...(choice ? { choice } : {}) },
	});
}

function closeOverflowMenu(): void {
	cornerShadow?.querySelector(".tp-menu")?.remove();
}

/** Loads the Username frame beside the card's read-only box, which stays if the page blocks it. */
function mountUsernameField(shadow: ShadowRoot): void {
	const box = shadow.querySelector<HTMLInputElement>("#tp-username");
	if (!box) return;
	// Unguessable, so a copy of the frame a page embeds itself has no card to talk to.
	const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
	const frame = document.createElement("iframe");
	frame.className = "tp-field";
	frame.title = t("fieldUsername");
	frame.setAttribute("scrolling", "no");
	frame.hidden = true;
	frame.src = `${FIELD_URL}?id=${id}`;
	box.after(frame);
	usernameField = { id, frame, box, value: null };
}

/** A message from the Username frame, relayed by the background. */
export function handleCornerField(payload: unknown): { ok: boolean; data?: { value: string } } {
	const p = payload as { id?: unknown; op?: unknown; value?: unknown; flush?: unknown } | undefined;
	const field = usernameField;
	if (!field || currentPrompt?.kind !== "save-login" || p?.id !== field.id) return { ok: false };
	if (p.op === "open") {
		// A frame the page made reload gets back what the user had typed.
		return { ok: true, data: { value: field.value ?? currentPrompt.username } };
	}
	if (p.op !== "value" || typeof p.value !== "string") return { ok: false };
	if (field.value === null) {
		// Its first report: the frame is live, so it takes the box's place and size.
		field.frame.style.height = `${field.box.offsetHeight || 38}px`;
		field.frame.hidden = false;
		field.box.hidden = true;
	}
	field.value = p.value;
	if (pendingFlush && p.flush === pendingFlush.n) pendingFlush.done();
	return { ok: true };
}

/** Resolves once the frame has reported its text as of now, or after FIELD_FLUSH_MS. */
function flushUsernameField(): Promise<void> {
	const win =
		usernameField && usernameField.value !== null ? usernameField.frame.contentWindow : null;
	if (!win) return Promise.resolve();
	return new Promise((resolve) => {
		const n = ++flushCount;
		const timer = setTimeout(done, FIELD_FLUSH_MS);
		function done(): void {
			clearTimeout(timer);
			if (pendingFlush?.n === n) pendingFlush = null;
			resolve();
		}
		pendingFlush = { n, done };
		// Carries only a counter, so "*" is fine.
		win.postMessage({ type: "CORNER_FIELD_FLUSH", n }, "*");
	});
}

/** Reply to a save with the Username box's text as it stands at the click. */
async function saveWithUsername(
	action: "save" | "save-unlock-first",
	extra: Record<string, unknown> = {},
): Promise<void> {
	const prompt = currentPrompt;
	saving = true;
	await flushUsernameField();
	// The card went, or another took its place, while the frame answered.
	if (!prompt || currentPrompt !== prompt) return;
	const editedUsername = usernameField?.value ?? undefined;
	sendCornerResponse(action, {
		...extra,
		...(editedUsername === undefined ? {} : { editedUsername }),
	});
	removeCornerPrompt();
}

/** Delegated click handler for all action buttons inside the corner-prompt card. */
function handleCornerCardClick(e: Event): void {
	if (saving) return;
	const target = e.target;
	if (!(target instanceof HTMLElement)) return;
	const actionEl = target.closest<HTMLElement>("[data-tp-action]");
	// Any click that isn't the overflow toggle or the menu itself closes an open menu.
	if (actionEl?.dataset.tpAction !== "toggle-menu") {
		if (!target.closest(".tp-menu")) closeOverflowMenu();
	}
	if (!actionEl || !cornerShadow?.contains(actionEl)) return;
	const action = actionEl.dataset.tpAction;
	if (!action || !currentPrompt) return;
	if (PASSKEY_CONSENT.has(action) && !consentClickCounts()) return;

	if (action === "toggle-password") {
		const pw = cornerShadow.querySelector<HTMLInputElement>("#tp-password");
		if (!pw) return;
		pw.type = pw.type === "password" ? "text" : "password";
		actionEl.textContent = t(pw.type === "password" ? "toggleShow" : "toggleHide");
		return;
	}
	if (action === "toggle-menu") {
		const existing = cornerShadow.querySelector(".tp-menu");
		if (existing) {
			existing.remove();
			return;
		}
		const menu = document.createElement("div");
		menu.className = "tp-menu";
		menu.innerHTML = html`<button data-tp-action="never">${t("menuNeverForSite")}</button>`;
		const actions = cornerShadow.querySelector(".tp-actions");
		(actions ?? cornerShadow).appendChild(menu);
		return;
	}

	if (action === "save") {
		void saveWithUsername("save");
		return;
	}
	if (action === "save-new") {
		// Its own action: a plain "save" re-runs dedupe, which folds a single match back into an update.
		sendCornerResponse("save-new");
		removeCornerPrompt();
		return;
	}
	if (action === "update") {
		const radio =
			cornerShadow.querySelector<HTMLInputElement>('input[name="tp-update-target"]:checked') ??
			cornerShadow.querySelector<HTMLInputElement>('input[name="tp-update-target"]');
		const chosenEntryId = radio?.value;
		if (!chosenEntryId) return;
		sendCornerResponse("update", { chosenEntryId });
		removeCornerPrompt();
		return;
	}
	if (action === "save-unlock-first") {
		// Pass chosenEntryId if picked: the locked-flow commit re-runs dedupe but
		// honors an explicit choice when present. The username field is editable on the
		// save card, so carry an edit through the unlock too (parity with "save").
		const radio = cornerShadow.querySelector<HTMLInputElement>(
			'input[name="tp-update-target"]:checked',
		);
		void saveWithUsername("save-unlock-first", radio ? { chosenEntryId: radio.value } : {});
		return;
	}
	if (action === "passkey-pick") {
		// Clicking an account row acts immediately (sign in / attach) with that choice.
		sendPasskeyResponse(true, actionEl.dataset.tpValue);
		removeCornerPrompt();
		return;
	}
	if (action === "passkey-approve") {
		sendPasskeyResponse(true);
		removeCornerPrompt();
		return;
	}
	if (action === "passkey-dismiss") {
		sendPasskeyResponse(false);
		removeCornerPrompt();
		return;
	}
	if (action === "dismiss") {
		sendCornerResponse("dismiss");
		removeCornerPrompt();
		return;
	}
	if (action === "never") {
		sendCornerResponse("never");
		removeCornerPrompt();
		return;
	}
}

/** Mounts the save/update corner prompt in the top-right of the page. */
export function handleCornerPromptShow(payload: CornerPromptPayload): void {
	// CORNER_PROMPT_SHOW is broadcast to every frame in the tab; only the top
	// frame paints the card (sub-frames would render it inside the iframe).
	if (!isTopFrame()) return;
	removeCornerPrompt();
	currentPrompt = payload;

	const root = document.createElement("div");
	root.id = CORNER_ID;
	// Inline so we don't depend on the inner stylesheet loading first.
	root.style.cssText = "position: fixed; top: 16px; right: 16px; z-index: 2147483647;";
	// Closed shadow root: keeps the captured credential out of page-readable DOM.
	const shadow = root.attachShadow({ mode: "closed" });
	let body: string;
	if (payload.kind === "save-login") {
		body = buildSaveLoginBody(payload);
	} else if (payload.kind === "update-login") {
		body = buildUpdateLoginBody(payload);
	} else {
		let label: string;
		if (payload.intent === "get") label = t(payload.locked ? "passkeyUnlockUse" : "passkeyUse");
		else if (payload.existingLoginName)
			label = t(payload.locked ? "passkeyUnlockAdd" : "passkeyAdd");
		else label = t(payload.locked ? "actionUnlockAndSave" : "passkeySave");
		body = savePasskeyBody({
			rpId: payload.rpId,
			rpName: payload.rpName,
			userName: payload.userName,
			intent: payload.intent,
			existingLoginName: payload.existingLoginName,
			candidates: payload.candidates,
			passkeyChoices: payload.passkeyChoices,
			primaryLabel: label,
			locked: payload.locked,
			requester: payload.requester,
			pageHost: location.hostname,
		});
	}
	// The card's box styling lives on the inner .tp-card (not :host) so a host
	// page's CSS reset can't reach it; the shadow boundary keeps it encapsulated.
	shadow.innerHTML = `${cornerStyles}<div class="tp-card">${body}</div>`;
	shadow.addEventListener("click", handleCornerCardClick, true);
	if (payload.kind === "save-login") mountUsernameField(shadow);

	cornerPromptEl = root;
	cornerShadow = shadow;
	cornerShownAt = Date.now();
	document.body.appendChild(root);
}

// Clicking outside the card closes the overflow menu but keeps the card (so the
// captured credential isn't lost).
document.addEventListener(
	"mousedown",
	(e) => {
		if (!cornerPromptEl) return;
		const target = e.target;
		if (!(target instanceof Node)) return;
		if (!cornerPromptEl.contains(target)) closeOverflowMenu();
	},
	true,
);

onTeardown(removeCornerPrompt);
