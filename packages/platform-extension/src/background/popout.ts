/// <reference types="chrome" />

import { api } from "../platform-api";
import { CORNER_HANDOFF_KEY } from "../session-keys";
import { getAutoLockMinutes } from "./prefs";
import { type MessageEnvelope, on } from "./router";
import { armViewGrace } from "./view-lock";

// In-memory only: a draft can hold a plaintext password, never persist to local.
export const POPOUT_HANDOFF_KEY = "popout.handoff";
// Id of the detached window we opened, so a later request focuses it instead of duplicating.
// storage.session (not local) survives a service-worker restart but clears on browser restart,
// which matches the lifetime of a chrome window id.
const POPOUT_WINDOW_KEY = "popout.windowId";
// Id of a pop-out opened solely to unlock (the picker's "Vault locked" row). It is a step in the
// page's fill flow, not a place the user asked to be, so it closes itself once the vault unlocks.
const POPOUT_UNLOCK_WINDOW_KEY = "popout.unlockWindowId";

/** Focus the tracked pop-out window if it is still open. Returns false when there is none:
 * the id was never stored, or the window was closed while the worker slept (windows.get
 * rejects), in which case the caller should open a fresh one. */
async function focusExistingPopout(): Promise<boolean> {
	const stored = await api.storage.session.get(POPOUT_WINDOW_KEY);
	const id = stored[POPOUT_WINDOW_KEY];
	if (typeof id !== "number") return false;
	const win = await api.windows.get(id).catch(() => undefined);
	if (win?.id === undefined) return false;
	const update: chrome.windows.UpdateInfo = { focused: true };
	if (win.state === "minimized") update.state = "normal"; // un-minimize; don't touch other states
	await api.windows.update(win.id, update).catch(() => undefined);
	return true;
}

const WIDTH = 500;
const HEIGHT = 600;
const CHROME_INSET = 80;

/** Create the pop-out window, anchored beside `anchor` when the position is usable. Chrome rejects
 *  bounds that fall (mostly) off-screen, which used to take the whole pop-out down with them - so a
 *  rejected position falls back to letting the browser place the window. */
async function createPopoutWindow(
	anchor: chrome.windows.Window | undefined,
): Promise<chrome.windows.Window | undefined> {
	const url = api.runtime.getURL("popup.html?detached=1");
	const base = { url, type: "popup" as const, focused: true, width: WIDTH, height: HEIGHT };
	const top = (anchor?.top ?? 0) + CHROME_INSET;
	const left = (anchor?.left ?? 0) + (anchor?.width ?? WIDTH) - WIDTH;
	const created = await api.windows.create({ ...base, top, left }).catch(() => undefined);
	if (!created) return api.windows.create(base).catch(() => undefined);
	if (created.id !== undefined) {
		// Re-assert the bounds: some platforms ignore them on create.
		await api.windows
			.update(created.id, { state: "normal", width: WIDTH, height: HEIGHT, top, left })
			.catch(() => undefined);
	}
	return created;
}

async function popoutOpen(
	message: any,
	sender: chrome.runtime.MessageSender,
): Promise<MessageEnvelope> {
	// The popup closes as the detached window takes focus; hold "Immediate" auto-lock across
	// that gap so popping out doesn't lock the vault out from under the new window.
	armViewGrace();

	const payload = message.payload as { handoff?: { draft?: unknown }; reason?: string } | undefined;
	const handoff = payload?.handoff;
	// Single instance: focus an already-open pop-out instead of spawning a duplicate. A request
	// carrying an in-flight draft is the exception - the open window consumed its boot handoff
	// once, so focusing it would silently drop the new draft (which can hold a plaintext
	// password). Route-only / unlock-request pop-outs have nothing to lose, so they dedupe.
	if (handoff?.draft === undefined && (await focusExistingPopout())) {
		return { ok: true };
	}

	// Stash the handoff before creating the window so the new window's boot read sees it.
	if (handoff) {
		await api.storage.session.set({ [POPOUT_HANDOFF_KEY]: handoff });
	} else {
		await api.storage.session.remove([POPOUT_HANDOFF_KEY]);
	}
	// Prefer the sender's window so the pop-out lands next to the active tab.
	let anchor: chrome.windows.Window | undefined;
	if (sender.tab?.windowId !== undefined) {
		anchor = await api.windows.get(sender.tab.windowId).catch(() => undefined);
	}
	if (!anchor) {
		anchor = await api.windows.getCurrent().catch(() => undefined);
	}
	const created = await createPopoutWindow(anchor);
	if (created?.id !== undefined) {
		// Track this window so the next pop-out request focuses it rather than duplicating.
		await api.storage.session.set({ [POPOUT_WINDOW_KEY]: created.id });
		// An unlock-only pop-out closes itself once the vault opens (see closeUnlockPopout).
		if (payload?.reason === "unlock") {
			await api.storage.session.set({ [POPOUT_UNLOCK_WINDOW_KEY]: created.id });
		}
	}
	return { ok: true };
}

/**
 * Close the pop-out that was opened just to unlock, now that the vault is open: the user asked to
 * fill a form, so the window has done its job and would otherwise sit over the page. No-op for a
 * pop-out the user opened themselves. Two cases keep it open: "Immediate" auto-lock, where closing
 * the last view would re-lock the vault we just unlocked (see view-lock.ts), and a parked corner
 * capture, which the unlocking view still has to flush (and confirm) before it goes away.
 */
// `sessionCurrent` is required, not defaulted: a default of "always current" would silently
// disarm the staleness check for any future caller that forgot to pass one.
export async function closeUnlockPopout(sessionCurrent: () => boolean): Promise<void> {
	try {
		if (!sessionCurrent()) return;
		const stored = await api.storage.session.get(POPOUT_UNLOCK_WINDOW_KEY);
		if (!sessionCurrent()) return;
		const id = stored[POPOUT_UNLOCK_WINDOW_KEY];
		if (typeof id !== "number") return;
		await api.storage.session.remove([POPOUT_UNLOCK_WINDOW_KEY]);
		if ((await getAutoLockMinutes()) < 0) return;
		if (!sessionCurrent()) return;
		const parked = await api.storage.session.get(CORNER_HANDOFF_KEY);
		if (!sessionCurrent()) return;
		if (parked[CORNER_HANDOFF_KEY]) return;
		await api.windows.remove(id).catch(() => undefined);
		// It was the tracked pop-out too; drop that so the next request opens a fresh window.
		const win = await api.storage.session.get(POPOUT_WINDOW_KEY);
		if (win[POPOUT_WINDOW_KEY] === id) await api.storage.session.remove([POPOUT_WINDOW_KEY]);
	} catch {}
}

async function popoutConsumeHandoff(): Promise<MessageEnvelope> {
	// Read-and-delete one-shot: reloading the window must not re-seed a stale draft.
	let handoff: unknown = null;
	try {
		const r = await api.storage.session.get(POPOUT_HANDOFF_KEY);
		handoff = r[POPOUT_HANDOFF_KEY] ?? null;
		await api.storage.session.remove([POPOUT_HANDOFF_KEY]);
	} catch {}
	return { ok: true, data: handoff };
}

on("POPOUT_OPEN", popoutOpen);
on("POPOUT_CONSUME_HANDOFF", popoutConsumeHandoff);
