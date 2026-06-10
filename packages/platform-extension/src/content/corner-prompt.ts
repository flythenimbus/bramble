/// <reference types="chrome" />

import { cornerStyles } from "./html/corner-styles";
import { saveLoginBody } from "./html/save-login-body";
import { updateLoginBody } from "./html/update-login-body";
import { isExtensionAlive, markExtensionDead, onTeardown, safeSendMessage } from "./lifecycle";
import { html } from "./template";
import type { CornerPromptPayload } from "./types";

const CORNER_ID = "titanpass-corner-prompt";

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
	if (!isExtensionAlive()) return;
	try {
		chrome.runtime
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
	const primaryLabel = p.locked ? "Unlock & Save" : "Save";
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
	const primaryLabel = p.locked ? "Unlock & Update" : "Update";
	const primaryAction = p.locked ? "save-unlock-first" : "update";
	// >1 candidate: ask which entry to update; exactly 1: confirm the rotation.
	const title = p.candidates.length > 1 ? "Update an existing login?" : "Update saved login?";
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

function closeOverflowMenu(): void {
	cornerShadow?.querySelector(".tp-menu")?.remove();
}

/** Delegated click handler for all action buttons inside the corner-prompt card. */
function handleCornerCardClick(e: Event): void {
	const target = e.target;
	if (!(target instanceof HTMLElement)) return;
	const actionEl = target.closest<HTMLElement>("[data-tp-action]");
	// Any click that isn't the overflow toggle or the menu itself closes an open menu.
	if (!actionEl || actionEl.dataset.tpAction !== "toggle-menu") {
		if (!target.closest(".tp-menu")) closeOverflowMenu();
	}
	if (!actionEl || !cornerShadow?.contains(actionEl)) return;
	const action = actionEl.dataset.tpAction;
	if (!action || !currentPrompt) return;

	if (action === "toggle-password") {
		const pw = cornerShadow.querySelector<HTMLInputElement>("#tp-password");
		if (!pw) return;
		pw.type = pw.type === "password" ? "text" : "password";
		actionEl.textContent = pw.type === "password" ? "Show" : "Hide";
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
		menu.innerHTML = html`<button data-tp-action="never">Never for this site</button>`;
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
	removeCornerPrompt();
	currentPrompt = payload;

	const root = document.createElement("div");
	root.id = CORNER_ID;
	// Inline so we don't depend on the inner stylesheet loading first.
	root.style.cssText = "position: fixed; top: 16px; right: 16px; z-index: 2147483647;";
	// Closed shadow root: keeps the captured credential out of page-readable DOM.
	const shadow = root.attachShadow({ mode: "closed" });
	const body =
		payload.kind === "save-login" ? buildSaveLoginBody(payload) : buildUpdateLoginBody(payload);
	shadow.innerHTML = cornerStyles + body;
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
