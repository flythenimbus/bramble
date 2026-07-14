/// <reference types="chrome" />

import { api } from "../platform-api";
import { type MessageEnvelope, on } from "./router";
import { armViewGrace } from "./view-lock";

// In-memory only: a draft can hold a plaintext password, never persist to local.
export const POPOUT_HANDOFF_KEY = "popout.handoff";
// Id of the detached window we opened, so a later request focuses it instead of duplicating.
// storage.session (not local) survives a service-worker restart but clears on browser restart,
// which matches the lifetime of a chrome window id.
export const POPOUT_WINDOW_KEY = "popout.windowId";

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

async function popoutOpen(
	message: any,
	sender: chrome.runtime.MessageSender,
): Promise<MessageEnvelope> {
	// The popup closes as the detached window takes focus; hold "Immediate" auto-lock across
	// that gap so popping out doesn't lock the vault out from under the new window.
	armViewGrace();

	const handoff = (message.payload as { handoff?: { draft?: unknown } } | undefined)?.handoff;
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
	const WIDTH = 500;
	const HEIGHT = 600;
	const CHROME_INSET = 80;
	// Prefer the sender's window so the pop-out lands next to the active tab.
	let anchor: chrome.windows.Window | undefined;
	if (sender.tab?.windowId !== undefined) {
		anchor = await api.windows.get(sender.tab.windowId).catch(() => undefined);
	}
	if (!anchor) {
		anchor = await api.windows.getCurrent().catch(() => undefined);
	}
	const top = (anchor?.top ?? 0) + CHROME_INSET;
	const left = (anchor?.left ?? 0) + (anchor?.width ?? WIDTH) - WIDTH;
	const created = await api.windows.create({
		url: api.runtime.getURL("popup.html?detached=1"),
		type: "popup",
		focused: true,
		width: WIDTH,
		height: HEIGHT,
		top,
		left,
	});
	if (created?.id !== undefined) {
		await api.windows.update(created.id, {
			state: "normal",
			width: WIDTH,
			height: HEIGHT,
			top,
			left,
		});
		// Track this window so the next pop-out request focuses it rather than duplicating.
		await api.storage.session.set({ [POPOUT_WINDOW_KEY]: created.id });
	}
	return { ok: true };
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
