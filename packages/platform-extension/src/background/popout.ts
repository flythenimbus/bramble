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
  const targetUrl = api.runtime.getURL("popup.html?detached=1");
  const WIDTH = 500;
  const HEIGHT = 600;
  const CHROME_INSET = 80;

  // CHECK FOR EXISTING INSTANCE: Query tabs for our unique detached extension URL
  const [existingTab] = await api.tabs.query({ url: targetUrl }).catch(() => []);

  if (existingTab?.windowId !== undefined) {
    // SINGLE WINDOW ENFORCEMENT: Bring the existing window to the front
    await api.windows.update(existingTab.windowId, { focused: true }).catch(() => undefined);
    armViewGrace();
    return { ok: true };
  }

  // --- Fallback to original window creation logic if no instance exists ---
  armViewGrace();
  const handoff = (message.payload as { handoff?: unknown } | undefined)?.handoff;
  if (handoff) {
    await api.storage.session.set({ [POPOUT_HANDOFF_KEY]: handoff });
  } else {
    await api.storage.session.remove([POPOUT_HANDOFF_KEY]);
  }

  let anchor: chrome.windows.Window | undefined;
  if (sender.tab?.windowId !== undefined) {
    anchor = await api.windows.get(sender.tab.windowId).catch(() => undefined);
  }
  if (!anchor) {
    anchor = await api.windows.getCurrent().catch(() => undefined);
  }

  const top = (anchor?.top ?? 0) + CHROME_INSET;
  const left = (anchor?.left ?? 0) + (anchor?.width ?? WIDTH) - WIDTH;

  // Create the single instance window
  const created = await api.windows.create({
    url: targetUrl,
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
