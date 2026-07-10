/// <reference types="chrome" />

import { api } from "../platform-api";
import { type MessageEnvelope, on } from "./router";
import { armViewGrace } from "./view-lock";

// In-memory only: a draft can hold a plaintext password, never persist to local.
export const POPOUT_HANDOFF_KEY = "popout.handoff";

async function popoutOpen(
	message: any,
	sender: chrome.runtime.MessageSender,
): Promise<MessageEnvelope> {
	// The popup closes as the detached window takes focus; hold "Immediate" auto-lock across
	// that gap so popping out doesn't lock the vault out from under the new window.
	armViewGrace();
	// Stash the handoff before creating the window so the new window's boot read sees it.
	const handoff = (message.payload as { handoff?: unknown } | undefined)?.handoff;
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
