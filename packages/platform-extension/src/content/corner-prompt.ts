/// <reference types="chrome" />

import { api } from "./content-api";
import { cornerStyles } from "./html/corner-styles";
import { saveLoginBody } from "./html/save-login-body";
import { savePasskeyBody } from "./html/save-passkey-body";
import { updateLoginBody } from "./html/update-login-body";
import { t } from "./i18n";
import { isExtensionAlive, markExtensionDead, onTeardown, safeSendMessage } from "./lifecycle";
import { html } from "./template";
import type { CornerPromptPayload } from "./types";

const CORNER_ID = "titanpass-corner-prompt";

// The save/update card is page-level UI, so render it only in the top frame.
// Capture still runs in every frame (so logins inside an iframe, e.g. Apple ID,
// are caught); the resulting prompt is shown once, on the page itself.
const isTopFrame = (): boolean => window.top === window.self;

let cornerPromptEl: HTMLElement | null = null;
// Closed shadow root of the corner prompt; in-card DOM queries go through this.
let cornerShadow: ShadowRoot | null = null;
let currentPrompt: CornerPromptPayload | null = null;

export function removeCornerPrompt(): void {
	if (cornerPromptEl) {
		cornerPromptEl.remove();
		cornerPromptEl = null;
	}
	cornerShadow = null;
	currentPrompt = null;
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

/** Delegated click handler for all action buttons inside the corner-prompt card. */
function handleCornerCardClick(e: Event): void {
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
		const usernameInput = cornerShadow.querySelector<HTMLInputElement>("#tp-username");
		const edited = usernameInput?.value;
		sendCornerResponse("save", { editedUsername: edited });
		removeCornerPrompt();
		return;
	}
	if (action === "save-new") {
		// Keep existing entries, add captured credential as a separate login;
		// same backend path as a fresh save-login.
		sendCornerResponse("save");
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
		// honors an explicit choice when present.
		const radio = cornerShadow.querySelector<HTMLInputElement>(
			'input[name="tp-update-target"]:checked',
		);
		sendCornerResponse("save-unlock-first", radio ? { chosenEntryId: radio.value } : undefined);
		removeCornerPrompt();
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
		});
	}
	// The card's box styling lives on the inner .tp-card (not :host) so a host
	// page's CSS reset can't reach it; the shadow boundary keeps it encapsulated.
	shadow.innerHTML = `${cornerStyles}<div class="tp-card">${body}</div>`;
	shadow.addEventListener("click", handleCornerCardClick, true);

	cornerPromptEl = root;
	cornerShadow = shadow;
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
